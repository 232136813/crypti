var ed = require('ed25519'),
	util = require('util'),
	ByteBuffer = require("bytebuffer"),
	crypto = require('crypto'),
	genesisblock = require('../helpers/genesisblock.js'),
	constants = require("../helpers/constants.js"),
	slots = require('../helpers/slots.js'),
	extend = require('extend'),
	Router = require('../helpers/router.js'),
	async = require('async'),
	RequestSanitizer = require('../helpers/request-sanitizer.js'),
	TransactionTypes = require('../helpers/transaction-types.js'),
	Diff = require('../helpers/diff.js'),
	errorCode = require('../helpers/errorCodes.js').error,
	sandboxHelper = require('../helpers/sandbox.js');

// private fields
var modules, library, self, private = {}, shared = {};
private.unconfirmedSignatures = {};

function Multisignature() {
	this.create = function (data, trs) {
		trs.recipientId = null;
		trs.amount = 0;
		trs.asset.multisignature = {
			min: data.min,
			keysgroup: data.keysgroup,
			lifetime: data.lifetime
		};

		return trs;
	}

	this.calculateFee = function (trs) {
		return 1 * constants.fixedPoint;
	}

	this.verify = function (trs, sender, cb) {
		if (!trs.asset.multisignature) {
			return setImmediate(cb, "Invalid asset: " + trs.id);
		}

		if (!util.isArray(trs.asset.multisignature.keysgroup)) {
			return setImmediate(cb, "Wrong transaction asset for multisignature transaction: " + trs.id);
		}

		if (trs.asset.multisignature.min < 1 || trs.asset.multisignature.min > 16) {
			return setImmediate(cb, "Wrong transaction asset min for multisignature transaction: " + trs.id);
		}

		if (trs.asset.multisignature.lifetime < 1 || trs.asset.multisignature.lifetime > 72) {
			return setImmediate(cb, "Wrong transaction asset lifetime for multisignature transaction: " + trs.id);
		}

		try {
			for (var s = 0; s < trs.asset.multisignature.keysgroup.length; s++) {
				var verify = false;
				if (trs.signatures) {
					for (var d = 0; d < trs.signatures.length && !verify; d++) {
						if (trs.asset.multisignature.keysgroup[s][0] != '-' && trs.asset.multisignature.keysgroup[s][0] != '+') {
							verify = false;
						} else {
							verify = library.logic.transaction.verifySecondSignature(trs, trs.asset.multisignature.keysgroup[s].substring(1), trs.signatures[d]);
						}
					}
				}
				if (!verify) {
					return setImmediate(cb, "Failed multisignature verification: " + trs.id);
				}
			}
		} catch (e) {
			return setImmediate(cb, "Failed multisignature exception: " + trs.id);
		}

		if (trs.asset.multisignature.keysgroup.indexOf(sender.publicKey) != -1) {
			return setImmediate(cb, errorCode("MULTISIGNATURES.SELF_SIGN"));
		}

		var keysgroup = trs.asset.multisignature.keysgroup.reduce(function (p, c) {
			if (p.indexOf(c) < 0) p.push(c);
			return p;
		}, []);

		if (keysgroup.length != trs.asset.multisignature.keysgroup.length) {
			return setImmediate(cb, errorCode("MULTISIGNATURES.NOT_UNIQUE_SET"));
		}

		setImmediate(cb, null, trs);
	}

	this.process = function (trs, sender, cb) {
		setImmediate(cb, null, trs);
	}

	this.getBytes = function (trs, skip) {
		var keysgroupBuffer = new Buffer(trs.asset.multisignature.keysgroup.join(''), 'utf8');

		var bb = new ByteBuffer(1 + 1 + keysgroupBuffer.length, true);
		bb.writeByte(trs.asset.multisignature.min);
		bb.writeByte(trs.asset.multisignature.lifetime);
		for (var i = 0; i < keysgroupBuffer.length; i++) {
			bb.writeByte(keysgroupBuffer[i]);
		}
		bb.flip();

		return bb.toBuffer();
	}

	this.apply = function (trs, sender, cb) {
		private.unconfirmedSignatures[sender.address] = false;

		this.scope.account.merge(sender.address, {
			multisignatures: trs.asset.multisignature.keysgroup,
			multimin: trs.asset.multisignature.min,
			multilifetime: trs.asset.multisignature.lifetime
		}, cb);
	}

	this.undo = function (trs, sender, cb) {
		var multiInvert = Diff.reverse(trs.asset.multisignature.keysgroup);

		private.unconfirmedSignatures[sender.address] = true;
		this.scope.account.merge(sender.address, {
			multisignatures: multiInvert,
			multimin: -trs.asset.multisignature.min,
			multilifetime: -trs.asset.multisignature.lifetime
		}, cb);
	}

	this.applyUnconfirmed = function (trs, sender, cb) {
		if (private.unconfirmedSignatures[sender.address]) {
			return setImmediate(cb, "Signature on this account wait for confirmation");
		}

		if (sender.multisignatures.length) {
			return setImmediate(cb, "This account already have multisignature");
		}

		private.unconfirmedSignatures[sender.address] = true;

		this.scope.account.merge(sender.address, {
			u_multisignatures: trs.asset.multisignature.keysgroup,
			u_multimin: trs.asset.multisignature.min,
			u_multilifetime: trs.asset.multisignature.lifetime
		}, function (err) {
			cb();
		});
	}

	this.undoUnconfirmed = function (trs, sender, cb) {
		var multiInvert = Diff.reverse(trs.asset.multisignature.keysgroup);

		private.unconfirmedSignatures[sender.address] = false;
		this.scope.account.merge(sender.address, {
			u_multisignatures: multiInvert,
			u_multimin: -trs.asset.multisignature.min,
			u_multilifetime: -trs.asset.multisignature.lifetime
		}, cb);
	}

	this.objectNormalize = function (trs) {
		var report = library.scheme.validate(trs.asset.multisignature, {
			type: "object",
			properties: {
				min: {
					type: "integer",
					minimum: 2,
					maximum: 16
				},
				keysgroup: {
					type: "array",
					minLength: 2,
					maxLength: 10
				},
				lifetime: {
					type: "integer",
					minimum: 1,
					maximum: 24
				}
			},
			required: ['min', 'keysgroup', 'lifetime']
		});

		if (!report) {
			throw Error(report.getLastError());
		}

		return trs;
	}

	this.dbRead = function (raw) {
		if (!raw.m_keysgroup) {
			return null
		} else {
			var multisignature = {
				min: raw.m_min,
				lifetime: raw.m_lifetime,
				keysgroup: raw.m_keysgroup.split(',')
			}

			return {multisignature: multisignature};
		}
	}

	this.dbSave = function (trs, cb) {
		library.dbLite.query("INSERT INTO multisignatures(min, lifetime, keysgroup, transactionId) VALUES($min, $lifetime, $keysgroup, $transactionId)", {
			min: trs.asset.multisignature.min,
			lifetime: trs.asset.multisignature.lifetime,
			keysgroup: trs.asset.multisignature.keysgroup.join(','),
			transactionId: trs.id
		}, cb);
	}

	this.ready = function (trs, sender) {
		if (!trs.signatures) {
			return false;
		}
		if (!sender.multisignatures.length) {
			return trs.signatures.length == trs.asset.multisignature.keysgroup.length;
		} else {
			return trs.signatures.length >= sender.multimin;
		}
	}
}

//constructor
function Multisignatures(cb, scope) {
	library = scope;
	self = this;
	self.__private = private;
	private.attachApi();

	library.logic.transaction.attachAssetType(TransactionTypes.MULTI, new Multisignature());

	setImmediate(cb, null, self);
}

//private methods
private.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) return next();
		res.status(500).send({success: false, error: errorCode('COMMON.LOADING')});
	});

	router.map(shared, {
		"get /pending": "pending", // get pendings transactions
		"post /sign": "sign", // sign transaction
		"put /": "addMultisignature", // enable
		"get /accounts": "getAccounts"
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: errorCode('COMMON.INVALID_API')});
	});

	library.network.app.use('/api/multisignatures', router);
	library.network.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error(req.url, err.toString());
		res.status(500).send({success: false, error: err.toString()});
	});
}

//public methods
Multisignatures.prototype.sandboxApi = function (call, args, cb) {
	sandboxHelper.callMethod(shared, call, args, cb);
}

//events
Multisignatures.prototype.onBind = function (scope) {
	modules = scope;
}

shared.getAccounts = function (req, cb) {
	var query = req.body;

	library.scheme.validate(query, {
		type: "object",
		properties: {
			publicKey: {
				type: "string",
				format: "publicKey"
			}
		}
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		library.dbLite.query("select GROUP_CONCAT(accountId) from mem_accounts2multisignatures where dependentId = $publicKey", {
			publicKey: query.publicKey
		}, ['accountId'], function (err, rows) {
			if (err) {
				library.logger.error(err.toString());
				return cb("Internal sql error");
			}

			var addresses = rows.map(function (item) {
				return item.accountId;
			});

			modules.accounts.getAccounts({
				address: {$in: addresses},
				sort: 'balance'
			}, ['address', 'balance'], function (err, rows) {
				if (err) {
					library.logger.error(err);
					return cb("Internal sql error");
				}

				return cb(null, {accounts: rows});
			});
		});
	});
}

//shared
shared.pending = function (req, cb) {
	var query = req.body;
	library.scheme.validate(query, {
		type: "object",
		properties: {
			publicKey: {
				type: "string",
				format: "publicKey"
			}
		},
		required: ['publicKey']
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		var transactions = modules.transactions.getUnconfirmedTransactionList();

		var pendings = [];
		async.forEach(transactions, function (item, cb) {
			var signature = item.signatures.find(function (signature) {
				return signature.publicKey == query.publicKey;
			});

			if (signature) {
				return setImmediate(cb);
			}

			if (item.multisignature.keysgroup.indexOf("+" + publicKey) >= 0) {
				pendings.push(item);
			}

			setImmediate(cb);
		}, function () {
			return cb(null, {transactions: pendings});
		});
	});
}

Multisignatures.prototype.processSignature = function (tx, cb) {
	var transaction = modules.transactions.getUnconfirmedTransaction(tx.transaction);

	function done(cb) {
		library.sequence.add(function (cb) {
			var transaction = modules.transactions.getUnconfirmedTransaction(tx.transaction);

			if (!transaction) {
				return cb("Transaction not found");
			}

			transaction.signatures = transaction.signatures || [];
			transaction.signatures.push(tx.signature);
			library.bus.message('signature', transaction, true);

			cb();
		}, cb);
	}

	if (!transaction) {
		return cb(errorCode("TRANSACTIONS.TRANSACTION_NOT_FOUND"));
	}

	if (transaction.type == TransactionTypes.MULTI) {
		if (transaction.asset.multisignature.signatures && transaction.asset.multisignature.signatures.indexOf(tx.signature) != -1) {
			return cb(errorCode("MULTISIGNATURES.SIGN_NOT_ALLOWED", transaction));
		}

		// find public key
		var verify = false;

		try {
			for (var i = 0; i < transaction.asset.multisignature.keysgroup && !verify; i++) {
				var key = transaction.asset.multisignature.keysgroup[i].substring(1);
				verify = library.logic.transaction.verifySecondSignature(transaction, key, tx.signature);
			}
		} catch (e) {
			return cb("Failed to signature verification");
		}

		if (!verify) {
			return cb("Failed to signature verification")
		}

		done(cb);
	} else {
		modules.accounts.getAccount({
			address: transaction.senderId
		}, function (err, account) {
			if (err) {
				return cb("Error, account for multisignature transaction not found");
			}

			var verify = false;
			try {
				for (var i = 0; i < account.multisignatures.length && !verify; i++) {
					verify = library.logic.transaction.verifySecondSignature(transaction, account.multisignatures[i].substring(1), tx.signature);
				}
			} catch (e) {
				return cb("Failed to verify signature: " + transaction.id);
			}

			if (!verify) {
				return cb("Failed to verify signature: " + transaction.id);
			}

			return done(cb);
		});
	}
}

shared.sign = function (req, cb) {
	var body = req.body;
	library.scheme.validate(body, {
		type: "object",
		properties: {
			secret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			},
			secondSecret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			},
			publicKey: {
				type: "string",
				format: "publicKey"
			},
			transactionId: {
				type: "string"
			}
		},
		required: ['transactionId', 'secret']
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		var transaction = modules.transactions.getUnconfirmedTransaction(body.transactionId);

		if (!transaction) {
			return cb(errorCode("TRANSACTIONS.TRANSACTION_NOT_FOUND"));
		}

		var hash = crypto.createHash('sha256').update(body.secret, 'utf8').digest();
		var keypair = ed.MakeKeypair(hash);

		if (body.publicKey) {
			if (keypair.publicKey.toString('hex') != body.publicKey) {
				return cb(errorCode("COMMON.INVALID_SECRET_KEY"));
			}
		}

		var sign = library.logic.transaction.sign(keypair, transaction);

		function done(cb) {
			library.sequence.add(function (cb) {
				var transaction = modules.transactions.getUnconfirmedTransaction(body.transactionId);

				if (!transaction) {
					return cb("Transaction not found");
				}

				transaction.signatures = transaction.signatures || [];
				transaction.signatures.push(sign);

				library.bus.message('signature', transaction, true);

				cb();
			}, function (err) {
				if (err) {
					return cb(err.toString());
				}

				cb(null, {transactionId: transaction.id});
			});
		}

		if (transaction.type == TransactionTypes.MULTI) {
			if (transaction.asset.multisignature.keysgroup.indexOf("+" + keypair.publicKey.toString('hex')) == -1 || (transaction.asset.multisignature.signatures && transaction.asset.multisignature.signatures.indexOf(sign) != -1)) {
				return cb(errorCode("MULTISIGNATURES.SIGN_NOT_ALLOWED", transaction));
			}

			done(cb);
		} else {
			modules.accounts.getAccount({
				address: transaction.senderId
			}, function (err, account) {
				if (err) {
					return cb("Error, account for multisignature transaction not found");
				}

				if (account.multisignatures.indexOf("+" + keypair.publicKey.toString('hex')) < 0) {
					return cb(errorCode("MULTISIGNATURES.SIGN_NOT_ALLOWED", transaction));
				}

				done(cb);
			});
		}
	});
}

shared.addMultisignature = function (req, cb) {
	var body = req.body;
	library.scheme.validate(body, {
		type: "object",
		properties: {
			secret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			},
			publicKey: {
				type: "string",
				format: "publicKey"
			},
			secondSecret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			},
			min: {
				type: "integer",
				minimum: 2,
				maximum: 16
			},
			lifetime: {
				type: "integer",
				minimum: 1,
				maximum: 24
			},
			keysgroup: {
				type: "array",
				minLength: 1,
				maxLength: 10
			}
		},
		required: ['min', 'lifetime', 'keysgroup', 'secret']
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		var hash = crypto.createHash('sha256').update(body.secret, 'utf8').digest();
		var keypair = ed.MakeKeypair(hash);

		if (body.publicKey) {
			if (keypair.publicKey.toString('hex') != body.publicKey) {
				return cb(errorCode("COMMON.INVALID_SECRET_KEY"));
			}
		}

		library.sequence.add(function (cb) {
			modules.accounts.getAccount({publicKey: keypair.publicKey.toString('hex')}, function (err, account) {
				if (err) {
					return cb(err.toString());
				}
				if (!account || !account.publicKey) {
					return cb(errorCode("COMMON.OPEN_ACCOUNT"));
				}

				if (account.secondSignature && !body.secondSecret) {
					return cb(errorCode("COMMON.SECOND_SECRET_KEY"));
				}

				var secondKeypair = null;

				if (account.secondSignature) {
					var secondHash = crypto.createHash('sha256').update(body.secondSecret, 'utf8').digest();
					secondKeypair = ed.MakeKeypair(secondHash);
				}

				try {
					var transaction = library.logic.transaction.create({
						type: TransactionTypes.MULTI,
						sender: account,
						keypair: keypair,
						secondKeypair: secondKeypair,
						min: body.min,
						keysgroup: body.keysgroup,
						lifetime: body.lifetime
					});
				} catch (e) {
					return cb(e.toString());
				}

				modules.transactions.receiveTransactions([transaction], cb);
			});
		}, function (err, transaction) {
			if (err) {
				return cb(err.toString());
			}

			cb(null, {transaction: transaction[0]});
		});
	});
}


//export
module.exports = Multisignatures;