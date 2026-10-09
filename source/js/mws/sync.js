/*
Two-way synchronisation between a TiddlyWiki store and a MultiWikiServer (MWS) wiki (recipe)

The engine works on any live TiddlyWiki wiki object: the wiki of a file wiki window, or the
wiki of a wiki folder process. It uses a three-way comparison: for every tiddler it remembers
a hash of the local and the remote version from the last successful sync, so it can tell which
side changed. When both sides changed a tiddler differently, the newer version wins and the
other one is kept as a conflict copy, so nothing is lost.

State is stored in a JSON file so that changes made while the wiki was closed are picked up
the next time it is opened.
*/

"use strict";

var crypto = require("crypto"),
	fs = require("fs"),
	path = require("path"),
	client = require("./client.js");

var READ_CHUNK = 100,
	WRITE_CHUNK = 25,
	PUSH_DELAY = 1500,
	DEFAULT_INTERVAL = 15000;

// Tiddlers that are specific to one copy of a wiki, or that MWS provides itself
var EXCLUDED_TITLES = ["$:/core","$:/StoryList","$:/HistoryList","$:/Import","$:/isEncrypted","$:/UploadName","$:/language","$:/theme","$:/palette"],
	EXCLUDED_PREFIXES = ["$:/temp/","$:/state/","$:/status/","$:/boot/","$:/library/","$:/plugins/tiddlywiki/","$:/themes/tiddlywiki/","$:/languages/","$:/core/"],
	EXCLUDED_FIELDS = ["revision","bag"];

function isExcludedTitle(title) {
	if(EXCLUDED_TITLES.indexOf(title) !== -1 || /^Draft( \d+)? of '/.test(title)) {
		return true;
	}
	for(var i = 0; i < EXCLUDED_PREFIXES.length; i++) {
		if(title.indexOf(EXCLUDED_PREFIXES[i]) === 0) {
			return true;
		}
	}
	return false;
}

// Exclude tiddlers by title, drafts, and stock plugins (MWS loads those through the recipe)
function isExcluded(title,fields) {
	return isExcludedTitle(title) || !!(fields && fields["draft.of"]);
}

function hashFields(fields) {
	if(!fields) {
		return null;
	}
	var keys = Object.keys(fields).filter(function(k) {return EXCLUDED_FIELDS.indexOf(k) === -1;}).sort(),
		normalised = keys.map(function(k) {return [k,String(fields[k])];});
	return crypto.createHash("md5").update(JSON.stringify(normalised)).digest("hex");
}

function chunks(array,size) {
	var result = [];
	for(var i = 0; i < array.length; i += size) {
		result.push(array.slice(i,i + size));
	}
	return result;
}

function sequence(items,fn) {
	return items.reduce(function(promise,item) {
		return promise.then(function() {return fn(item);});
	},Promise.resolve());
}

function conflictTimestamp() {
	var d = new Date(),
		pad = function(n) {return (n < 10 ? "0" : "") + n;};
	return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/*
options.id: identifier of the sync link, used for the state file
options.wiki: the TiddlyWiki wiki object to synchronise
options.Tiddler: the $tw.Tiddler class belonging to that wiki
options.baseUrl, options.recipe: the MWS server and wiki (recipe slug)
options.getSession: function returning the session id to use, or null for anonymous access
options.stateFolder: folder for the state file
options.interval: milliseconds between checks for remote changes
options.initialMode: "merge" (newer wins, loser kept as conflict copy), "local" or "remote" (that side wins); only for the first sync
options.onStatus: function(status) called whenever the status changes
options.log: function(line)
*/
function SyncEngine(options) {
	this.options = options;
	this.wiki = options.wiki;
	this.Tiddler = options.Tiddler;
	this.statePath = path.resolve(options.stateFolder,options.id.replace(/[^A-Za-z0-9_\-]/g,"_") + ".json");
	this.dirty = new Set();
	this.status = {state: "starting", message: "", lastSync: "", pushed: 0, pulled: 0, conflicts: 0, skipped: 0};
	this.loadState();
}

SyncEngine.prototype.log = function(line) {
	if(this.options.log) {
		this.options.log(line);
	}
};

SyncEngine.prototype.setStatus = function(fields) {
	Object.assign(this.status,fields);
	if(this.options.onStatus) {
		this.options.onStatus(Object.assign({},this.status));
	}
};

// #region State

SyncEngine.prototype.loadState = function() {
	var state = null;
	try {
		state = JSON.parse(fs.readFileSync(this.statePath,"utf8"));
	} catch(e) {}
	if(!state || state.format !== 1 || state.baseUrl !== this.options.baseUrl || state.recipe !== this.options.recipe) {
		state = {format: 1, baseUrl: this.options.baseUrl, recipe: this.options.recipe, initialized: false, lastSeq: "0", base: {}, skipped: {}};
	}
	this.state = state;
};

SyncEngine.prototype.saveState = function() {
	fs.mkdirSync(path.dirname(this.statePath),{recursive: true});
	var temp = this.statePath + ".tmp";
	fs.writeFileSync(temp,JSON.stringify(this.state));
	fs.renameSync(temp,this.statePath);
};

SyncEngine.prototype.setBase = function(title,localHash,remoteHash) {
	if(localHash === null && remoteHash === null) {
		delete this.state.base[title];
	} else {
		this.state.base[title] = {l: localHash, r: remoteHash};
	}
};

// #endregion

// #region Lifecycle

SyncEngine.prototype.start = function() {
	var self = this;
	this.stopped = false;
	this.changeListener = function(changes) {
		var any = false;
		Object.keys(changes).forEach(function(title) {
			if(!isExcludedTitle(title)) {
				self.dirty.add(title);
				any = true;
			}
		});
		if(any) {
			self.schedule(PUSH_DELAY);
		}
	};
	this.wiki.addEventListener("change",this.changeListener);
	// Pick up local changes made while the engine was not running
	this.fullScanPending = true;
	this.schedule(0);
	this.timer = setInterval(function() {
		self.schedule(0);
	},this.options.interval || DEFAULT_INTERVAL);
};

SyncEngine.prototype.stop = function() {
	this.stopped = true;
	clearInterval(this.timer);
	clearTimeout(this.pushTimer);
	if(this.changeListener) {
		this.wiki.removeEventListener("change",this.changeListener);
	}
	this.setStatus({state: "stopped"});
};

// Run a sync cycle after a delay, coalescing requests
SyncEngine.prototype.schedule = function(delay) {
	var self = this;
	if(this.stopped) {
		return;
	}
	clearTimeout(this.pushTimer);
	this.pushTimer = setTimeout(function() {
		self.cycle();
	},delay);
};

SyncEngine.prototype.syncNow = function() {
	this.fullScanPending = true;
	this.schedule(0);
};

// Forget the sync state so that the next cycle is an initial sync again
SyncEngine.prototype.reset = function(initialMode) {
	this.state = {format: 1, baseUrl: this.options.baseUrl, recipe: this.options.recipe, initialized: false, lastSeq: "0", base: {}, skipped: {}};
	if(initialMode) {
		this.options.initialMode = initialMode;
	}
	this.saveState();
	this.syncNow();
};

SyncEngine.prototype.cycle = function() {
	var self = this;
	if(this.running) {
		this.pendingCycle = true;
		return Promise.resolve();
	}
	this.running = true;
	this.counts = {pushed: 0, pulled: 0, conflicts: 0, skipped: 0};
	this.setStatus({state: "syncing"});
	var work = this.state.initialized ? this.incrementalSync() : this.initialSync();
	return work.then(function() {
		self.saveState();
		var c = self.counts,
			parts = [];
		if(c.pushed) {parts.push(c.pushed + " uploaded");}
		if(c.pulled) {parts.push(c.pulled + " downloaded");}
		if(c.conflicts) {parts.push(c.conflicts + " conflicts (copies kept)");}
		if(c.skipped) {parts.push(c.skipped + " not uploaded (no write permission)");}
		if(parts.length) {
			self.log("Sync: " + parts.join(", "));
		}
		self.setStatus({
			state: "ok",
			lastSync: new Date().toISOString(),
			message: parts.length ? parts.join(", ") : (self.status.message && self.status.state === "ok" ? self.status.message : "up to date"),
			pushed: self.status.pushed + c.pushed,
			pulled: self.status.pulled + c.pulled,
			conflicts: self.status.conflicts + c.conflicts,
			skipped: Object.keys(self.state.skipped).length
		});
	},function(err) {
		try {
			self.saveState();
		} catch(e) {}
		var offline = err && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|timed out/.test(String(err.code || err.message));
		self.log("Sync failed: " + ((err && err.message) || err));
		self.setStatus({
			state: offline ? "offline" : (err && (err.status === 401 || err.status === 403) ? "login" : "error"),
			message: offline ? "Server not reachable, will retry" : ((err && err.message) || String(err))
		});
	}).then(function() {
		self.running = false;
		if(self.pendingCycle || (self.dirty.size && self.timer)) {
			self.pendingCycle = false;
			self.schedule(PUSH_DELAY);
		}
	});
};

// #endregion

// #region Local and remote access

SyncEngine.prototype.localFields = function(title) {
	if(!this.wiki.tiddlerExists(title)) {
		return null;
	}
	var tiddler = this.wiki.getTiddler(title);
	return tiddler ? tiddler.getFieldStrings() : null;
};

SyncEngine.prototype.localTitles = function() {
	var self = this;
	return this.wiki.allTitles().filter(function(title) {
		var tiddler = self.wiki.getTiddler(title);
		return !isExcluded(title,tiddler && tiddler.fields);
	});
};

// Bring remote fields into the same string form as local fields
SyncEngine.prototype.canonical = function(fields) {
	if(!fields) {
		return null;
	}
	var copy = {};
	Object.keys(fields).forEach(function(k) {
		if(EXCLUDED_FIELDS.indexOf(k) === -1) {
			copy[k] = fields[k];
		}
	});
	return new this.Tiddler(copy).getFieldStrings();
};

SyncEngine.prototype.api = function(pathname,options) {
	options = options || {};
	options.session = this.options.getSession ? this.options.getSession() : null;
	return client.requestJson(this.options.baseUrl,"/recipe/" + encodeURIComponent(this.options.recipe) + pathname,options);
};

// Read remote tiddlers, returning a map of title to canonical fields
SyncEngine.prototype.readRemote = function(titles) {
	var self = this,
		result = {};
	return sequence(chunks(titles,READ_CHUNK),function(chunk) {
		return self.api("/batch/read",{method: "PUT", body: {titles: chunk}}).then(function(items) {
			(items || []).forEach(function(item) {
				if(item && item.fields && item.fields.title) {
					result[item.fields.title] = self.canonical(item.fields);
				}
			});
		});
	}).then(function() {
		return result;
	});
};

// #endregion

// #region Applying changes

SyncEngine.prototype.pull = function(title,remoteFields) {
	var remoteHash = hashFields(remoteFields);
	if(remoteFields) {
		this.wiki.addTiddler(new this.Tiddler(remoteFields));
	} else if(this.wiki.tiddlerExists(title)) {
		this.wiki.deleteTiddler(title);
	}
	this.setBase(title,hashFields(this.localFields(title)),remoteHash);
	delete this.state.skipped[title];
	this.counts.pulled++;
};

// Upload local versions; fields null means delete
SyncEngine.prototype.push = function(items) {
	var self = this,
		saves = items.filter(function(item) {return item.fields;}),
		deletes = items.filter(function(item) {return !item.fields;});
	var onSaved = function(item) {
			var hash = hashFields(item.fields);
			self.setBase(item.title,hash,hashFields(self.canonical(item.fields)));
			delete self.state.skipped[item.title];
			self.counts.pushed++;
		},
		onDeleted = function(item) {
			self.setBase(item.title,null,null);
			delete self.state.skipped[item.title];
			self.counts.pushed++;
		},
		onRefused = function(item,err) {
			// Usually a tiddler in a read only bag. Remember it so that it is not retried until it changes again
			var hash = hashFields(item.fields),
				base = self.state.base[item.title];
			self.state.skipped[item.title] = hash;
			self.setBase(item.title,hash,base ? base.r : null);
			self.counts.skipped++;
			self.log("Could not upload \"" + item.title + "\": " + ((err && err.message) || err));
		};
	// A batch fails as a whole if one item is refused, so retry refused batches one by one
	var run = function(op,list,body,onSuccess) {
		return sequence(chunks(list,WRITE_CHUNK),function(chunk) {
			return self.api("/batch/" + op,{method: "PUT", body: body(chunk)}).then(function() {
				chunk.forEach(onSuccess);
			},function(err) {
				if(err.status !== 403 && err.status !== 400) {
					throw err;
				}
				return sequence(chunk,function(item) {
					return self.api("/batch/" + op,{method: "PUT", body: body([item])}).then(function() {
						onSuccess(item);
					},function(err) {
						if(err.status !== 403 && err.status !== 400) {
							throw err;
						}
						onRefused(item,err);
					});
				});
			});
		});
	};
	return run("save",saves,function(list) {
		return {tiddlers: list.map(function(item) {return item.fields;})};
	},onSaved).then(function() {
		return run("delete",deletes,function(list) {
			return {titles: list.map(function(item) {return item.title;})};
		},onDeleted);
	});
};

// Keep the losing version of a conflict as a separate tiddler
SyncEngine.prototype.keepConflictCopy = function(fields,side) {
	var copy = Object.assign({},fields);
	copy.title = fields.title + " (sync conflict, " + side + " version, " + conflictTimestamp() + ")";
	copy["sync-conflict-of"] = fields.title;
	this.wiki.addTiddler(new this.Tiddler(copy));
	// Upload the copy in the next cycle so that both sides keep it
	this.dirty.add(copy.title);
	this.counts.conflicts++;
	this.log("Conflict on \"" + fields.title + "\": kept the " + side + " version as \"" + copy.title + "\"");
};

/*
Resolve a tiddler that both sides changed differently
Returns an item to push, or null
*/
SyncEngine.prototype.resolveConflict = function(title,local,remote,mode) {
	if(!local) {
		// Deleted locally, changed remotely: keep the change
		this.pull(title,remote);
		return null;
	}
	if(!remote) {
		// Deleted remotely, changed locally: keep the change
		return {title: title, fields: local};
	}
	var localWins = mode === "local" || (mode !== "remote" && (local.modified || "") >= (remote.modified || ""));
	if(localWins) {
		if(mode === "merge") {
			this.keepConflictCopy(remote,"server");
		}
		return {title: title, fields: local};
	}
	if(mode === "merge") {
		this.keepConflictCopy(local,"local");
	}
	this.pull(title,remote);
	return null;
};

// #endregion

// #region Sync cycles

SyncEngine.prototype.initialSync = function() {
	var self = this,
		mode = this.options.initialMode || "merge",
		lastSeq, remoteTitles;
	this.log("First sync with " + this.options.baseUrl + " wiki \"" + this.options.recipe + "\" (" + mode + ")");
	// Get the change sequence number first, so that changes made during the sync are picked up next time
	return this.api("/updates?since=0").then(function(updates) {
		lastSeq = updates.lastSeq;
		return self.api("/list.json");
	}).then(function(list) {
		remoteTitles = (list || []).map(function(info) {return info.title;}).filter(function(title) {return !isExcludedTitle(title);});
		return self.readRemote(remoteTitles);
	}).then(function(remote) {
		var toPush = [],
			titles = new Set(self.localTitles().concat(Object.keys(remote)));
		titles.forEach(function(title) {
			var local = self.localFields(title),
				remoteFields = remote[title] || null;
			if(remoteFields && isExcluded(title,remoteFields)) {
				return;
			}
			if(local && !remoteFields) {
				toPush.push({title: title, fields: local});
			} else if(!local && remoteFields) {
				self.pull(title,remoteFields);
			} else if(hashFields(local) === hashFields(remoteFields)) {
				self.setBase(title,hashFields(local),hashFields(remoteFields));
			} else {
				var item = self.resolveConflict(title,local,remoteFields,mode);
				if(item) {
					toPush.push(item);
				}
			}
		});
		return self.push(toPush);
	}).then(function() {
		self.state.lastSeq = lastSeq;
		self.state.initialized = true;
		self.dirty.clear();
		self.fullScanPending = false;
	});
};

SyncEngine.prototype.incrementalSync = function() {
	var self = this,
		updates, candidates;
	return this.api("/updates?since=" + encodeURIComponent(this.state.lastSeq)).then(function(result) {
		updates = result;
		var modified = new Set((updates.modifications || []).filter(function(t) {return !isExcludedTitle(t);})),
			deleted = new Set((updates.deletions || []).filter(function(t) {return !isExcludedTitle(t);}));
		candidates = new Set(self.dirty);
		self.dirty.clear();
		if(self.fullScanPending) {
			self.fullScanPending = false;
			self.localTitles().forEach(function(title) {
				var base = self.state.base[title];
				if(!base || base.l !== hashFields(self.localFields(title))) {
					candidates.add(title);
				}
			});
			Object.keys(self.state.base).forEach(function(title) {
				if(!self.wiki.tiddlerExists(title)) {
					candidates.add(title);
				}
			});
		}
		modified.forEach(function(t) {candidates.add(t);});
		deleted.forEach(function(t) {candidates.add(t);});
		updates.modified = modified;
		updates.deleted = deleted;
		var toRead = Array.from(modified).filter(function(t) {return candidates.has(t);});
		return self.readRemote(toRead);
	}).then(function(remote) {
		var toPush = [];
		candidates.forEach(function(title) {
			var base = self.state.base[title] || {l: null, r: null},
				local = self.localFields(title),
				localHash = hashFields(local),
				isRemoteEvent = updates.modified.has(title) || updates.deleted.has(title),
				remoteFields = updates.modified.has(title) ? (remote[title] || null) : null,
				remoteHash = isRemoteEvent ? hashFields(remoteFields) : base.r,
				localChanged = localHash !== base.l,
				remoteChanged = isRemoteEvent && remoteHash !== base.r;
			if(local && isExcluded(title,local)) {
				return;
			}
			if(remoteFields && isExcluded(title,remoteFields)) {
				return;
			}
			// Local edits to tiddlers that were refused before are not retried until they change again
			if(localChanged && !remoteChanged && self.state.skipped[title] === localHash) {
				return;
			}
			if(localChanged && !remoteChanged) {
				toPush.push({title: title, fields: local});
			} else if(!localChanged && remoteChanged) {
				self.pull(title,remoteFields);
			} else if(localChanged && remoteChanged) {
				if(localHash === remoteHash) {
					self.setBase(title,localHash,remoteHash);
				} else {
					var item = self.resolveConflict(title,local,remoteFields,"merge");
					if(item) {
						toPush.push(item);
					}
				}
			}
		});
		return self.push(toPush);
	}).then(function() {
		self.state.lastSeq = updates.lastSeq;
	});
};

// #endregion

exports.SyncEngine = SyncEngine;
exports.isExcludedTitle = isExcludedTitle;
exports.hashFields = hashFields;
