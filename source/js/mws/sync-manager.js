/*
Links wikis in the wiki list to wikis on MultiWikiServer (MWS) servers and keeps them in sync

Link configuration (saved):     $:/TiddlyDesktop/Config/mws-sync/<wiki url>
Sync status (temporary):        $:/temp/TiddlyDesktop/MWS/SyncStatus/<wiki url>

Wiki file windows run in this process, so their sync engine runs here. Wiki folder windows
run in their own process; their engine is started there (see wiki-folder-main.js) and reports
its status through a file.
*/

"use strict";

var crypto = require("crypto"),
	fs = require("fs"),
	os = require("os"),
	path = require("path");

var client = require("./client.js"),
	SyncEngine = require("./sync.js").SyncEngine,
	quotePosix = require("./runner.js").quotePosix;

var LINK_PREFIX = "$:/TiddlyDesktop/Config/mws-sync/",
	STATUS_PREFIX = "$:/temp/TiddlyDesktop/MWS/SyncStatus/",
	STOCK_PLUGIN = /^\$:\/(plugins|themes)\/tiddlywiki\/([^\/]+)$/,
	STOCK_LANGUAGE = /^\$:\/languages\/([^\/]+)$/;

function SyncManager(mws) {
	this.mws = mws;
	this.engines = {}; // wiki url -> SyncEngine for file wikis
	this.folderLinks = {}; // wiki url -> link id for open folder wikis
	this.sessions = new client.SessionStore(mws.appDataPath);
	this.stateFolder = path.resolve(mws.appDataPath,"mws-sync");
}

// #region Links

SyncManager.prototype.linkId = function(wikiUrl) {
	return crypto.createHash("md5").update(wikiUrl).digest("hex").slice(0,16);
};

SyncManager.prototype.getLink = function(wikiUrl) {
	var tiddler = $tw.wiki.getTiddler(LINK_PREFIX + wikiUrl);
	if(!tiddler || !tiddler.fields.server || !tiddler.fields.recipe) {
		return null;
	}
	var f = tiddler.fields,
		server = this.mws.getServer(f.server);
	return {
		wikiUrl: wikiUrl,
		id: this.linkId(wikiUrl),
		serverId: f.server,
		server: server,
		recipe: f.recipe,
		enabled: f.enabled !== "no",
		background: f.background === "yes",
		initialMode: f["initial-mode"] || "merge",
		interval: (parseInt(f.interval,10) || 15) * 1000,
		baseUrl: server ? this.mws.getUrl(server) : ""
	};
};

SyncManager.prototype.getLinkedWikis = function() {
	return $tw.wiki.filterTiddlers("[all[tiddlers]prefix[" + LINK_PREFIX + "]removeprefix[" + LINK_PREFIX + "]]");
};

SyncManager.prototype.saveLink = function(wikiUrl,fields) {
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(LINK_PREFIX + wikiUrl),{title: LINK_PREFIX + wikiUrl},fields));
};

SyncManager.prototype.setStatus = function(wikiUrl,status) {
	var fields = {title: STATUS_PREFIX + wikiUrl};
	Object.keys(status).forEach(function(k) {
		fields[k] = status[k] === undefined || status[k] === null ? "" : String(status[k]);
	});
	if(status.lastSync) {
		fields["last-sync"] = $tw.utils.stringifyDate(new Date(status.lastSync));
	}
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(STATUS_PREFIX + wikiUrl),fields));
};

// The session for a server, or null for anonymous access
SyncManager.prototype.getSession = function(serverId) {
	var entry = this.sessions.get(serverId);
	return entry ? entry.session : null;
};

// #endregion

// #region Login

// Paths of local MWS installations, which include the OPAQUE library needed to log in
SyncManager.prototype.opaquePaths = function() {
	var self = this;
	return this.mws.getServerIds().map(function(id) {
		var server = self.mws.getServer(id);
		return server.kind === "local" ? server.path : null;
	}).filter(Boolean);
};

SyncManager.prototype.login = function(serverId,username,password) {
	var self = this,
		server = this.mws.getServer(serverId);
	if(!server) {
		return Promise.reject(new Error("Unknown server"));
	}
	return client.login(this.mws.getUrl(server),username,password,this.opaquePaths()).then(function(result) {
		self.sessions.set(serverId,{username: username, session: result.session, userId: result.userId, created: new Date().toISOString()});
		self.mws.setState(serverId,{"sync-user": username});
		// Retry links that were waiting for a login
		self.syncAllNow(serverId);
		return username;
	});
};

SyncManager.prototype.logout = function(serverId) {
	var entry = this.sessions.get(serverId),
		server = this.mws.getServer(serverId);
	this.sessions.set(serverId,null);
	this.mws.setState(serverId,{"sync-user": ""});
	if(entry && server) {
		// Ending the session on the server is best effort
		client.request(this.mws.getUrl(server),"/logout",{method: "POST", session: entry.session}).catch(function() {});
	}
};

SyncManager.prototype.refreshLoginState = function() {
	var self = this;
	this.mws.getServerIds().forEach(function(id) {
		var entry = self.sessions.get(id);
		self.mws.setState(id,{"sync-user": entry ? entry.username : ""});
	});
};

// #endregion

// #region Engines

/*
Called when a wiki file window has loaded its wiki
twInstance: the $tw object of the wiki inside the window
*/
SyncManager.prototype.attachFileWiki = function(wikiUrl,twInstance) {
	this.detach(wikiUrl);
	var link = this.getLink(wikiUrl);
	if(!link || !link.enabled) {
		return;
	}
	if(!twInstance || !twInstance.wiki || !twInstance.Tiddler) {
		this.setStatus(wikiUrl,{state: "error", message: "Only TiddlyWiki 5 wikis can be synchronised"});
		return;
	}
	if(!link.server) {
		this.setStatus(wikiUrl,{state: "error", message: "The server of this link was removed"});
		return;
	}
	var self = this,
		engine = new SyncEngine({
			id: link.id,
			wiki: twInstance.wiki,
			Tiddler: twInstance.Tiddler,
			baseUrl: link.baseUrl,
			recipe: link.recipe,
			getSession: function() {return self.getSession(link.serverId);},
			stateFolder: this.stateFolder,
			interval: link.interval,
			initialMode: link.initialMode,
			onStatus: function(status) {self.setStatus(wikiUrl,status);},
			log: function(line) {self.mws.log(link.serverId,"[" + link.recipe + "] " + line);}
		});
	this.engines[wikiUrl] = engine;
	engine.start();
};

SyncManager.prototype.detach = function(wikiUrl) {
	var engine = this.engines[wikiUrl];
	if(engine) {
		engine.stop();
		delete this.engines[wikiUrl];
	}
	delete this.folderLinks[wikiUrl];
};

/*
Settings for the sync engine of a wiki folder process, passed in the window URL. Returns null if not linked
*/
SyncManager.prototype.getFolderSyncSettings = function(wikiUrl) {
	var link = this.getLink(wikiUrl);
	if(!link || !link.enabled || !link.server) {
		return null;
	}
	this.folderLinks[wikiUrl] = link.id;
	return {
		id: link.id,
		serverId: link.serverId,
		baseUrl: link.baseUrl,
		recipe: link.recipe,
		interval: link.interval,
		initialMode: link.initialMode,
		dataPath: this.mws.appDataPath
	};
};

// Read the status files written by wiki folder processes
SyncManager.prototype.pollFolderStatus = function() {
	var self = this;
	Object.keys(this.folderLinks).forEach(function(wikiUrl) {
		var filename = path.resolve(self.stateFolder,self.folderLinks[wikiUrl] + ".status.json");
		try {
			var status = JSON.parse(fs.readFileSync(filename,"utf8")),
				current = $tw.wiki.getTiddler(STATUS_PREFIX + wikiUrl);
			if(!current || current.fields.updated !== status.updated) {
				self.setStatus(wikiUrl,status);
			}
		} catch(e) {}
	});
};

SyncManager.prototype.syncNow = function(wikiUrl) {
	var engine = this.engines[wikiUrl],
		link = this.getLink(wikiUrl);
	if(engine) {
		engine.syncNow();
	} else if(this.folderLinks[wikiUrl] && link) {
		// Wiki folder processes watch for this file
		fs.mkdirSync(this.stateFolder,{recursive: true});
		fs.writeFileSync(path.resolve(this.stateFolder,link.id + ".trigger"),"");
	} else if(link) {
		// Not open: open it in the background, which starts the sync
		$tw.desktop.windowList.openByUrl(wikiUrl,{hidden: true});
	}
};

SyncManager.prototype.syncAllNow = function(serverId) {
	var self = this;
	this.getLinkedWikis().forEach(function(wikiUrl) {
		var link = self.getLink(wikiUrl);
		if(link && link.serverId === serverId && (self.engines[wikiUrl] || self.folderLinks[wikiUrl])) {
			self.syncNow(wikiUrl);
		}
	});
};

// Restart the engine of an open wiki after its link changed
SyncManager.prototype.restart = function(wikiUrl) {
	var engine = this.engines[wikiUrl];
	if(engine) {
		var twWiki = engine.wiki,
			Tiddler = engine.Tiddler;
		this.attachFileWiki(wikiUrl,{wiki: twWiki, Tiddler: Tiddler});
	} else if(this.folderLinks[wikiUrl]) {
		this.setStatus(wikiUrl,{state: "restart", message: "Close and reopen the wiki folder to apply the change"});
	} else if(this.getLink(wikiUrl)) {
		var link = this.getLink(wikiUrl);
		if(link.enabled && link.background) {
			$tw.desktop.windowList.openByUrl(wikiUrl,{hidden: true});
		}
	}
};

// Open linked wikis in the background so they stay in sync while TiddlyDesktop runs
SyncManager.prototype.startBackgroundSync = function() {
	var self = this;
	this.getLinkedWikis().forEach(function(wikiUrl) {
		var link = self.getLink(wikiUrl);
		self.setStatus(wikiUrl,{state: link && link.enabled ? "closed" : "paused", message: link && link.enabled ? "Syncs while the wiki is open" : "Sync is paused"});
		if(link && link.enabled && link.background) {
			$tw.desktop.windowList.openByUrl(wikiUrl,{hidden: true});
		}
	});
};

// #endregion

// #region Publish and link

// The stock plugins, themes and languages used by a local wiki, as tiddlywiki.info entries
SyncManager.prototype.readWikiInfo = function(wikiUrl) {
	var info = {plugins: [], themes: [], languages: []};
	var add = function(title) {
		var m = STOCK_PLUGIN.exec(title),
			l = STOCK_LANGUAGE.exec(title);
		if(m) {
			var list = m[1] === "themes" ? info.themes : info.plugins;
			if(list.indexOf("tiddlywiki/" + m[2]) === -1) {
				list.push("tiddlywiki/" + m[2]);
			}
		} else if(l && info.languages.indexOf(l[1]) === -1) {
			info.languages.push(l[1]);
		}
	};
	if(wikiUrl.indexOf("wikifolder://") === 0) {
		var folderInfo = JSON.parse(fs.readFileSync(path.resolve(wikiUrl.slice(13),"tiddlywiki.info"),"utf8"));
		return {plugins: folderInfo.plugins || [], themes: folderInfo.themes || [], languages: folderInfo.languages || []};
	}
	var html = fs.readFileSync(wikiUrl.replace(/^wikifile:\/\//,""),"utf8");
	$tw.wiki.deserializeTiddlers("text/html",html).forEach(function(fields) {
		if(fields["plugin-type"]) {
			add(fields.title);
		}
	});
	return info;
};

/*
Create a new wiki on an MWS server for a local wiki and keep the two in sync
params: server (id), recipe (slug), description, background ("yes"/"no")
*/
SyncManager.prototype.publish = function(wikiUrl,params) {
	var self = this,
		server = this.mws.getServer(params.server),
		recipe = (params.recipe || "").trim();
	if(!server) {
		return Promise.reject(new Error("Choose a server"));
	}
	if(!/^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(recipe)) {
		return Promise.reject(new Error("The wiki name may only contain letters, digits, - and _"));
	}
	if(server.kind === "remote") {
		return Promise.reject(new Error("For a server that is only known by its URL, create the wiki on the MWS admin page, then use \"Link to existing\""));
	}
	if(!this.getSession(server.id)) {
		return Promise.reject(new Error("Log in to \"" + server.name + "\" first (MWS servers window, Account section)"));
	}
	var info = Object.assign({description: "Published from TiddlyDesktop"},this.readWikiInfo(wikiUrl)),
		description = params.description || ("Published from TiddlyDesktop: " + path.basename(wikiUrl.replace(/^wiki(file|folder):\/\//,""))),
		username = (this.sessions.get(server.id) || {}).username,
		args = function(folder,root) {
			return ["load-wiki-folder",folder,
				"--bag-relative-root",root,
				"--bag-description",description,
				"--recipe-name",recipe,
				"--recipe-description",description,
				"--owner-roles","ADMIN"];
		};
	return this.mws.task(server.id,"Publish \"" + recipe + "\"",function() {
		var r = self.mws.getRunner(server),
			log = self.mws.logger(server.id),
			infoJson = JSON.stringify(info);
		var create;
		if(server.kind === "local") {
			// An empty wiki folder named like the wiki: MWS creates a bag and a wiki (recipe) from it
			var root = fs.mkdtempSync(path.join(os.tmpdir(),"td-publish-")),
				folder = path.join(root,recipe);
			fs.mkdirSync(path.join(folder,"tiddlers"),{recursive: true});
			fs.writeFileSync(path.join(folder,"tiddlywiki.info"),infoJson);
			create = r.mws(args(folder,root),log).then(function(result) {
				fs.rmSync(root,{recursive: true, force: true});
				return result;
			});
		} else {
			var remoteRoot = ".td-publish-" + Date.now(),
				remoteFolder = remoteRoot + "/" + recipe;
			create = r.shellInDataPath("mkdir -p " + quotePosix(remoteFolder + "/tiddlers") + " && printf '%s' " + quotePosix(infoJson) + " > " + quotePosix(remoteFolder + "/tiddlywiki.info"),log).then(function() {
				return r.mws(args(remoteFolder,remoteRoot),log);
			}).then(function(result) {
				return r.shellInDataPath("rm -rf " + quotePosix(remoteRoot)).then(function() {return result;});
			});
		}
		return create.then(function(result) {
			if(result.code !== 0 || !/load-wiki-folder complete/.test(result.output)) {
				var reason = (/(Recipe|Bag) \S+ already exists/.exec(result.output) || [])[0];
				throw new Error(reason ? reason + ". Choose another name, or use \"Link to existing\"." : "Creating the wiki failed, see the log");
			}
			self.saveLink(wikiUrl,{server: server.id, recipe: recipe, enabled: "yes", background: params.background === "no" ? "no" : "yes", "initial-mode": "local"});
			log("Wiki \"" + recipe + "\" created" + (username ? " (owner role ADMIN)" : "") + ". Uploading the local wiki...");
			self.restartOrOpen(wikiUrl);
			return "Published as " + self.mws.getUrl(server) + "wiki/" + recipe;
		}).catch(function(err) {
			self.setStatus(wikiUrl,{state: "error", message: "Publishing failed: " + ((err && err.message) || err)});
			throw err;
		});
	});
};

/*
Link a local wiki to an existing wiki on an MWS server
params: server, recipe, initial-mode ("merge", "local", "remote"), background
*/
SyncManager.prototype.link = function(wikiUrl,params) {
	var self = this,
		server = this.mws.getServer(params.server),
		recipe = (params.recipe || "").trim();
	if(!server || !recipe) {
		return Promise.reject(new Error("Choose a server and enter the name of the wiki on the server"));
	}
	// Check access before saving the link
	return client.requestJson(this.mws.getUrl(server),"/recipe/" + encodeURIComponent(recipe) + "/status",{session: this.getSession(server.id)}).then(function(status) {
		var writable = (status.bags || []).some(function(bag) {return bag.canUserWrite;});
		self.saveLink(wikiUrl,{server: server.id, recipe: recipe, enabled: "yes", background: params.background === "no" ? "no" : "yes", "initial-mode": params["initial-mode"] || "merge"});
		self.restartOrOpen(wikiUrl);
		return writable ? "Linked" : "Linked, but this user cannot write to the wiki: local changes will not be uploaded";
	},function(err) {
		if(err.status === 404) {
			throw new Error("There is no wiki called \"" + recipe + "\" on " + server.name);
		}
		throw err;
	});
};

SyncManager.prototype.restartOrOpen = function(wikiUrl) {
	if(this.engines[wikiUrl]) {
		this.restart(wikiUrl);
	} else if(this.folderLinks[wikiUrl]) {
		this.setStatus(wikiUrl,{state: "restart", message: "Close and reopen the wiki folder to start syncing"});
	} else {
		$tw.desktop.windowList.openByUrl(wikiUrl,{hidden: true});
	}
};

SyncManager.prototype.unlink = function(wikiUrl) {
	var link = this.getLink(wikiUrl);
	this.detach(wikiUrl);
	$tw.wiki.deleteTiddler(LINK_PREFIX + wikiUrl);
	$tw.wiki.deleteTiddler(STATUS_PREFIX + wikiUrl);
	if(link) {
		[".json",".status.json",".trigger"].forEach(function(suffix) {
			fs.rmSync(path.resolve(this.stateFolder,link.id + suffix),{force: true});
		},this);
	}
};

SyncManager.prototype.setEnabled = function(wikiUrl,enabled) {
	this.saveLink(wikiUrl,{enabled: enabled ? "yes" : "no"});
	if(!enabled) {
		this.detach(wikiUrl);
		this.setStatus(wikiUrl,{state: "paused", message: "Sync is paused"});
	} else {
		this.restartOrOpen(wikiUrl);
	}
};

// #endregion

SyncManager.prototype.init = function() {
	var self = this;
	this.refreshLoginState();
	this.startBackgroundSync();
	this.timer = setInterval(function() {
		self.pollFolderStatus();
	},3000);
};

exports.SyncManager = SyncManager;
