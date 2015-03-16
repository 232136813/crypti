var async = require('async'),
	util = require('util'),
	ip = require('ip'),
	Router = require('../helpers/router.js'),
	params = require('../helpers/params.js'),
	arrayHelper = require('../helpers/array.js'),
	normalize = require('../helpers/normalize.js'),
	extend = require('extend'),
	fs = require('fs'),
	path = require('path');

require('array.prototype.find'); //old node fix

//private fields
var modules, library, self;

//constructor
function Peer(cb, scope) {
	library = scope;
	self = this;

	attachApi();

	setImmediate(cb, null, self);
}

//private methods
function attachApi() {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) return next();
		res.status(500).send({success: false, error: 'loading'});
	});

	router.get('/', function (req, res) {
		var state = params.int(req.query.state, true),
			os = params.string(req.query.os, true),
			version = params.string(req.query.version, true),
			limit = params.int(req.query.limit, true),
			shared = params.bool(req.query.shared, true),
			orderBy = params.string(req.query.orderBy, true),
			offset = params.int(req.query.offset, true),
			port = params.int(req.query.port, true);

		getByFilter({
			port: port,
			state: state,
			os: os,
			version: version,
			limit: limit,
			shared: shared,
			orderBy: orderBy,
			offset: offset
		}, function (err, peers) {
			if (err) {
				return res.json({success: false, error: "Peers not found"});
			}

			for (var i = 0; i < peers.length; i++) {
				peers[i].ip = ip.fromLong(peers[i].ip);
			}

			res.json({success: true, peers: peers});
		});
	});

	router.get('/version', function (req, res) {
		fs.readFile(path.join(__dirname, '..', 'build'), 'utf8', function (err, data) {
			if (err) {
				library.logger.error("Can't read build file: " + err);
				return res.json({success: false, error: "Can't read 'build' file, see logs"});
			}

			return res.json({success: true, version: library.config.version, build: data.trim()});
		});
	})

	router.get('/get', function (req, res) {
		var ip_str = params.string(req.query.ip);
		var port = params.int(req.query.port);

		try {
			ip_str = ip.toLong(ip_str);
		} catch (e) {
			return res.json({success: false, error: "Provide valid ip"});
		}

		if (!ip_str) {
			return res.json({success: false, error: "Provide ip in url"});
		}

		if (!port) {
			return res.json({success: false, error: "Provide port in url"});
		}

		getByFilter({
			ip: ip_str,
			port: port
		}, function (err, peers) {
			if (err) {
				return res.json({success: false, error: "Peers not found"});
			}

			var peer = peers.length ? peers[0] : null;

			if (peer) {
				peer.ip = ip.fromLong(peer.ip);
			}

			res.json({success: true, peer: peer || {}});
		});
	})

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: 'api not found'});
	});

	library.app.use('/api/peers', router);
	library.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error('/api/peers', err)
		res.status(500).send({success: false, error: err.toString()});
	});
}

function updatePeerList(cb) {
	modules.transport.getFromRandomPeer('/list', function (err, data) {
		if (err) {
			return cb();
		}

		var peers = params.array(data.body.peers);
		async.eachLimit(peers, 2, function (peer, cb) {
			peer = normalize.peer(peer);

			if (ip.toLong("127.0.0.1") == peer.ip || peer.port == 0 || peer.port > 65535) {
				setImmediate(cb);
				return;
			}

			self.update(peer, cb);
		}, cb);
	});
}

function count(cb) {
	var params = {};

	library.dbLite.query("select count(rowid) from peers", {"count": Number}, function (err, rows) {
		if (err) {
			library.logger.error('Peer#count', err);
			return cb(err);
		}
		var res = rows.length && rows[0].count;
		cb(null, res)
	})
}

function banManager(cb) {
	library.dbLite.query("UPDATE peers SET state = 1, clock = null where (state = 0 and clock - $now < 0)", {now: Date.now()}, cb);
}

function getByFilter(filter, cb) {
	var limit = filter.limit || null;
	var offset = filter.offset || null;
	delete filter.limit;
	delete filter.offset;

	var where = [];
	var params = {};

	if (filter.hasOwnProperty('state') && filter.state !== null) {
		where.push("state = $state");
		params.state = filter.state;
	}

	if (filter.hasOwnProperty('os') && filter.os !== null) {
		where.push("os = $os");
		params.os = filter.os;
	}

	if (filter.hasOwnProperty('version') && filter.version !== null) {
		where.push("version = $version");
		params.version = filter.version;
	}

	if (filter.hasOwnProperty('shared') && filter.shared !== null) {
		where.push("sharePort = $sharePort");
		params.sharePort = filter.shared;
	}

	if (filter.hasOwnProperty('ip') && filter.ip !== null) {
		where.push("ip = $ip");
		params.ip = filter.ip;
	}

	if (filter.hasOwnProperty('port') && filter.port !== null) {
		where.push("port = $port");
		params.port = filter.port;
	}

	if (limit !== null) {
		if (limit > 100) {
			return cb("Maximum limit is 100");
		}
		params['limit'] = limit;
	}

	if (offset !== null) {
		params['offset'] = offset;
	}

	library.dbLite.query("select ip, port, state, os, sharePort, version from peers" + (where.length ? (' where ' + where.join(' and ')) : '') + (limit ? ' limit $limit' : '') + (offset ? ' offset $offset ' : ''), params, {
		"ip": String,
		"port": Number,
		"state": Number,
		"os": String,
		"sharePort": Number,
		"version": String
	}, function (err, rows) {
		cb(err, rows);
	});
}

//public methods
Peer.prototype.list = function (limit, cb) {
	limit = limit || 100;
	var params = {limit: limit};

	library.dbLite.query("select ip, port, state, os, sharePort, version from peers where state > 0 and sharePort = 1 ORDER BY RANDOM() LIMIT $limit", params, {
		"ip": String,
		"port": Number,
		"state": Number,
		"os": String,
		"sharePort": Number,
		"version": String
	}, function (err, rows) {
		cb(err, rows);
	});
}

Peer.prototype.state = function (ip, port, state, timeoutSeconds, cb) {
	if (state == 0) {
		var clock = (timeoutSeconds || 1) * 1000;
		clock = Date.now() + clock;
	} else {
		clock = null;
	}
	library.dbLite.query("UPDATE peers SET state = $state, clock = $clock WHERE ip = $ip and port = $port;", {
		state: state,
		clock: clock,
		ip: ip,
		port: port
	}, function (err) {
		err && library.logger.error('Peer#state', err);

		cb && cb()
	});
}

Peer.prototype.remove = function (ip, port, cb) {
	var isFrozenList = library.config.peers.list.find(function (peer) {
		return peer.ip == ip && peer.port == port;
	});
	if (isFrozenList !== undefined) return cb && cb();
	library.dbLite.query("DELETE FROM peers WHERE ip = $ip and port = $port;", {
		ip: ip,
		port: port
	}, function (err) {
		err && library.logger.error('Peer#delete', err);

		cb && cb()
	});
}

Peer.prototype.update = function (peer, cb) {
	var params = {
		ip: peer.ip,
		port: peer.port,
		os: peer.os || null,
		sharePort: peer.sharePort,
		version: peer.version || null
	}
	async.series([
		function (cb) {
			library.dbLite.query("INSERT OR IGNORE INTO peers (ip, port, state, os, sharePort, version) VALUES ($ip, $port, $state, $os, $sharePort, $version);", extend({}, params, {state: 1}), cb);
		},
		function (cb) {
			if (peer.state !== undefined) {
				params.state = peer.state;
			}
			library.dbLite.query("UPDATE peers SET os = $os, sharePort = $sharePort, version = $version" + (peer.state !== undefined ? ", state = CASE WHEN state = 0 THEN state ELSE $state END " : "") + " WHERE ip = $ip and port = $port;", params, cb);
		}
	], function (err) {
		err && library.logger.error('Peer#update', err);
		cb && cb()
	})
}

//events
Peer.prototype.onBind = function (scope) {
	modules = scope;
}

Peer.prototype.onBlockchainReady = function () {
	async.eachSeries(library.config.peers.list, function (peer, cb) {
		library.dbLite.query("INSERT OR IGNORE INTO peers(ip, port, state, sharePort) VALUES($ip, $port, $state, $sharePort)", {
			ip: ip.toLong(peer.ip),
			port: peer.port,
			state: 2,
			sharePort: Number(true)
		}, cb);
	}, function (err) {
		if (err) {
			library.logger.error('onBlockchainReady', err);
		}

		count(function (err, count) {
			if (count) {
				updatePeerList(function (err) {
					err && library.logger.error('updatePeerList', err);
					library.bus.message('peerReady');
				})
				library.logger.info('peer ready, stored ' + count);
			} else {
				library.logger.warn('peer list is empty');
			}
		});
	});
}

Peer.prototype.onPeerReady = function () {
	process.nextTick(function nextUpdatePeerList() {
		updatePeerList(function (err) {
			err && library.logger.error('updatePeerList timer', err);
			setTimeout(nextUpdatePeerList, 60 * 1000);
		})
	});

	process.nextTick(function nextBanManager() {
		banManager(function (err) {
			err && library.logger.error('banManager timer', err);
			setTimeout(nextBanManager, 65 * 1000)
		});
	});
}

//export
module.exports = Peer;
