/*
Install, run, administer and back up MultiWikiServer (MWS) instances

Server configurations are stored as tiddlers in the backstage wiki:

	$:/TiddlyDesktop/MWS/Server/<id>

Runtime state is kept in temporary tiddlers that are not saved:

	$:/temp/TiddlyDesktop/MWS/State/<id>     status, current task and last message
	$:/temp/TiddlyDesktop/MWS/Log/<id>       recent console output
	$:/temp/TiddlyDesktop/MWS/Backup/<id>/<name>   one tiddler per backup
	$:/temp/TiddlyDesktop/MWS/Environment    versions of node, npm and ssh
*/

"use strict";

var fs = require("fs"),
	path = require("path"),
	http = require("http"),
	https = require("https");

var runner = require("./runner.js"),
	LocalRunner = runner.LocalRunner,
	SshRunner = runner.SshRunner,
	quotePosix = runner.quotePosix;

var SERVER_TAG = "$:/tags/TiddlyDesktop/MWSServer",
	SERVER_PREFIX = "$:/TiddlyDesktop/MWS/Server/",
	STATE_PREFIX = "$:/temp/TiddlyDesktop/MWS/State/",
	LOG_PREFIX = "$:/temp/TiddlyDesktop/MWS/Log/",
	BACKUP_PREFIX = "$:/temp/TiddlyDesktop/MWS/Backup/",
	ENV_TITLE = "$:/temp/TiddlyDesktop/MWS/Environment",
	NODE_FOLDER_TITLE = "$:/TiddlyDesktop/MWS/Config/NodeFolder",
	BACKUP_FOLDER_TITLE = "$:/TiddlyDesktop/MWS/Config/BackupFolder",
	CREATE_PACKAGE = "@tiddlywiki/create-mws@latest",
	MWS_PACKAGE = "@tiddlywiki/mws",
	INSTANCE_PACKAGE_NAME = "@tiddlywiki/mws-instance",
	MAX_LOG_LINES = 400,
	STARTUP_TIMEOUT = 120 * 1000,
	SCHEDULER_INTERVAL = 5 * 60 * 1000;

function MwsManager(options) {
	options = options || {};
	this.appDataPath = options.appDataPath;
	this.children = {}; // id -> ChildProcess of servers started by us
	this.busy = {}; // id -> true while a task is running
	this.logBuffers = {}; // id -> array of lines
	this.logTimers = {};
}

// #region Helpers

function timestamp(date) {
	date = date || new Date();
	var pad = function(n) {return (n < 10 ? "0" : "") + n;};
	return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "_" +
		pad(date.getHours()) + "-" + pad(date.getMinutes()) + "-" + pad(date.getSeconds());
}

function readJson(filename) {
	try {
		return JSON.parse(fs.readFileSync(filename,"utf8"));
	} catch(e) {
		return null;
	}
}

function slugify(text) {
	return (text || "mws").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,30) || "mws";
}

function delay(ms) {
	return new Promise(function(resolve) {setTimeout(resolve,ms);});
}

function filesEqual(a,b) {
	try {
		return fs.readFileSync(a).equals(fs.readFileSync(b));
	} catch(e) {
		return false;
	}
}

// Older MWS versions print an error but exit with code 0 for unknown commands
function isUnknownCommand(result,command) {
	return /unknown command/i.test(result.output) || result.output.indexOf("Command \"" + command + "\" not found") !== -1;
}

// #endregion

// #region Configuration and state

MwsManager.prototype.getServerIds = function() {
	return $tw.wiki.filterTiddlers("[all[tiddlers]tag[" + SERVER_TAG + "]prefix[" + SERVER_PREFIX + "]removeprefix[" + SERVER_PREFIX + "]]");
};

MwsManager.prototype.getServer = function(id) {
	var tiddler = $tw.wiki.getTiddler(SERVER_PREFIX + id);
	if(!tiddler) {
		return null;
	}
	var f = tiddler.fields;
	return {
		id: id,
		title: f.title,
		name: f.caption || id,
		kind: f["mws-kind"] || "local",
		path: f["mws-path"] || "",
		host: f["mws-host"] || "localhost",
		port: f["mws-port"] || "8080",
		url: f["mws-url"] || "",
		autostart: f["mws-autostart"] === "yes",
		backupPath: f["mws-backup-path"] || "",
		backupKeep: parseInt(f["mws-backup-keep"],10) || 0,
		backupInterval: parseFloat(f["mws-backup-interval"]) || 0,
		backupPasswordsKey: f["mws-backup-passwords-key"] !== "no",
		backupBeforeUpdate: f["mws-backup-before-update"] !== "no",
		sshTarget: f["ssh-target"] || "",
		sshPort: f["ssh-port"] || "",
		sshPrefix: f["ssh-prefix"] || "",
		sshStart: f["ssh-start"] || "",
		sshStop: f["ssh-stop"] || ""
	};
};

MwsManager.prototype.addServer = function(fields) {
	var base = slugify(fields.caption),
		id = base,
		n = 2;
	while($tw.wiki.tiddlerExists(SERVER_PREFIX + id)) {
		id = base + "-" + (n++);
	}
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),{
		title: SERVER_PREFIX + id,
		tags: [SERVER_TAG],
		"mws-backup-keep": "10",
		"mws-backup-interval": "0",
		"mws-backup-passwords-key": "yes",
		"mws-backup-before-update": "yes",
		"mws-autostart": "no"
	},fields,$tw.wiki.getModificationFields()));
	this.setState(id,{status: "unknown"});
	return id;
};

// Suggest a port that is not used by another registered server
MwsManager.prototype.suggestPort = function() {
	var self = this,
		used = this.getServerIds().map(function(id) {return self.getServer(id).port;}),
		port = 8080;
	while(used.indexOf(String(port)) !== -1) {
		port++;
	}
	return String(port);
};

MwsManager.prototype.getState = function(id) {
	var tiddler = $tw.wiki.getTiddler(STATE_PREFIX + id);
	return tiddler ? tiddler.fields : {};
};

MwsManager.prototype.setState = function(id,fields) {
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(STATE_PREFIX + id),{title: STATE_PREFIX + id},fields));
};

MwsManager.prototype.log = function(id,line) {
	var self = this,
		buffer = this.logBuffers[id];
	if(!buffer) {
		buffer = this.logBuffers[id] = ($tw.wiki.getTiddlerText(LOG_PREFIX + id) || "").split("\n").filter(Boolean);
	}
	buffer.push(line);
	if(buffer.length > MAX_LOG_LINES) {
		buffer.splice(0,buffer.length - MAX_LOG_LINES);
	}
	// Writing the tiddler triggers a refresh, so batch the updates
	if(!this.logTimers[id]) {
		this.logTimers[id] = setTimeout(function() {
			self.logTimers[id] = null;
			$tw.wiki.addTiddler({title: LOG_PREFIX + id, type: "text/plain", text: self.logBuffers[id].join("\n")});
		},250);
	}
};

MwsManager.prototype.clearLog = function(id) {
	this.logBuffers[id] = [];
	$tw.wiki.addTiddler({title: LOG_PREFIX + id, type: "text/plain", text: ""});
};

MwsManager.prototype.logger = function(id) {
	var self = this;
	return function(line) {
		self.log(id,line);
	};
};

MwsManager.prototype.getNodeFolder = function() {
	return ($tw.wiki.getTiddlerText(NODE_FOLDER_TITLE) || "").trim();
};

MwsManager.prototype.getRunner = function(server) {
	if(server.kind === "ssh") {
		return new SshRunner({
			target: server.sshTarget,
			port: server.sshPort,
			dataPath: server.path,
			prefix: server.sshPrefix,
			nodeFolder: this.getNodeFolder()
		});
	} else if(server.kind === "local") {
		return new LocalRunner({
			dataPath: server.path,
			nodeFolder: this.getNodeFolder()
		});
	}
	return null;
};

// The URL used to reach the server from this computer
MwsManager.prototype.getUrl = function(server) {
	if(server.url) {
		return server.url.replace(/\/+$/,"") + "/";
	}
	var host = server.host;
	if(server.kind === "ssh") {
		host = server.sshTarget.split("@").pop();
	} else if(!host || host === "0.0.0.0" || host === "::") {
		host = "localhost";
	}
	if(host.indexOf(":") !== -1 && host.charAt(0) !== "[") {
		host = "[" + host + "]";
	}
	return "http://" + host + ":" + server.port + "/";
};

MwsManager.prototype.getBackupFolder = function(server) {
	if(server.backupPath) {
		return path.resolve(server.backupPath);
	}
	var root = ($tw.wiki.getTiddlerText(BACKUP_FOLDER_TITLE) || "").trim() || path.resolve(this.appDataPath,"mws-backups");
	return path.resolve(root,server.id);
};

// #endregion

// #region Tasks

/*
Run an operation for a server, making sure only one operation runs at a time per server
*/
MwsManager.prototype.task = function(id,label,fn) {
	var self = this,
		server = this.getServer(id);
	if(!server) {
		return Promise.resolve();
	}
	if(this.busy[id]) {
		this.alert("\"" + server.name + "\" is busy: " + this.getState(id).task);
		return Promise.resolve();
	}
	this.busy[id] = true;
	this.setState(id,{task: label, message: ""});
	this.log(id,"");
	this.log(id,"=== " + label + " (" + new Date().toLocaleString() + ")");
	return Promise.resolve().then(function() {
		return fn(server);
	}).then(function(message) {
		self.log(id,"=== Done: " + label);
		self.setState(id,{message: message || (label + " completed"), "message-type": "success", "message-time": new Date().toLocaleString()});
	},function(err) {
		var text = (err && err.message) || String(err);
		self.log(id,"=== Failed: " + text);
		self.setState(id,{message: label + " failed: " + text, "message-type": "error", "message-time": new Date().toLocaleString()});
	}).then(function() {
		self.busy[id] = false;
		self.setState(id,{task: ""});
		return self.checkStatus(id);
	});
};

MwsManager.prototype.alert = function(text) {
	(new $tw.utils.Logger("MWS")).alert(text);
};

// Throw if a command failed
function check(result,what) {
	if(result.code !== 0) {
		throw new Error(what + " exited with code " + result.code);
	}
	return result;
}

// #endregion

// #region Status

function ping(url) {
	return new Promise(function(resolve) {
		var lib = url.indexOf("https:") === 0 ? https : http,
			req;
		try {
			req = lib.get(url,{timeout: 3000, rejectUnauthorized: false},function(res) {
				res.resume();
				resolve(true);
			});
		} catch(e) {
			return resolve(false);
		}
		req.on("timeout",function() {
			req.destroy();
			resolve(false);
		});
		req.on("error",function() {
			resolve(false);
		});
	});
}

MwsManager.prototype.checkStatus = function(id) {
	var self = this,
		server = this.getServer(id);
	if(!server) {
		return Promise.resolve();
	}
	var fields = {url: this.getUrl(server)};
	if(server.kind === "local") {
		var localRunner = this.getRunner(server),
			pkg = readJson(localRunner.resolve("node_modules","@tiddlywiki","mws","package.json"));
		fields.installed = localRunner.isInstalled() ? "yes" : "no";
		fields["mws-version"] = pkg ? pkg.version : "";
		fields["folder-exists"] = fs.existsSync(server.path) ? "yes" : "no";
	}
	return ping(fields.url).then(function(up) {
		var child = self.children[id],
			current = self.getState(id).status;
		if(child) {
			// Keep "starting" until the server answers
			fields.status = up ? "running" : (current === "starting" ? "starting" : "error");
			fields.pid = String(child.pid);
		} else {
			fields.status = up ? (server.kind === "local" ? "external" : "running") : (server.kind === "remote" ? "unreachable" : "stopped");
			fields.pid = "";
		}
		self.setState(id,fields);
		return up;
	});
};

MwsManager.prototype.checkAll = function() {
	var self = this;
	return Promise.all(this.getServerIds().map(function(id) {
		return self.busy[id] ? null : self.checkStatus(id);
	}));
};

MwsManager.prototype.checkEnvironment = function() {
	var env = runner.buildEnv(this.getNodeFolder()),
		fields = {title: ENV_TITLE, checked: new Date().toLocaleString()},
		isWindows = process.platform === "win32",
		version = function(command,args) {
			return runner.run(command,args,{env: env, shell: isWindows && command === "npm"}).then(function(result) {
				return result.code === 0 ? result.output.trim().split("\n").pop() : "";
			},function() {
				return "";
			});
		};
	return Promise.all([
		version("node",["--version"]),
		version("npm",["--version"]),
		version("ssh",["-V"])
	]).then(function(versions) {
		fields.node = versions[0];
		fields.npm = versions[1];
		fields.ssh = versions[2];
		var major = parseInt((versions[0] || "").replace(/^v/,""),10);
		fields["node-ok"] = major >= 20 ? "yes" : "no";
		$tw.wiki.addTiddler(new $tw.Tiddler(fields));
	});
};

// #endregion

// #region Start and stop

MwsManager.prototype.start = function(id) {
	var self = this;
	return this.task(id,"Start server",function(server) {
		return self.startServer(server);
	});
};

MwsManager.prototype.stop = function(id) {
	var self = this;
	return this.task(id,"Stop server",function(server) {
		return self.stopServer(server);
	});
};

MwsManager.prototype.restart = function(id) {
	var self = this;
	return this.task(id,"Restart server",function(server) {
		return self.stopServer(server).then(function() {
			return self.startServer(server);
		});
	});
};

MwsManager.prototype.startServer = function(server) {
	var self = this,
		id = server.id,
		url = this.getUrl(server);
	if(server.kind === "remote") {
		throw new Error("Remote servers are started on the server itself");
	}
	return ping(url).then(function(up) {
		if(up) {
			throw new Error("Something is already answering at " + url + ". Stop it or choose another port.");
		}
		if(server.kind === "ssh") {
			return self.getRunner(server).shellInDataPath(self.getSshStartCommand(server),self.logger(id)).then(function(result) {
				check(result,"Start command");
				return self.waitUntilUp(server,null);
			});
		}
		var localRunner = self.getRunner(server);
		if(!localRunner.isInstalled()) {
			throw new Error("MWS is not installed in " + server.path + ". Use \"repair\" to run npm ci.");
		}
		var args = ["host=" + server.host,"port=" + server.port],
			child = localRunner.spawnListen(args,self.logger(id));
		self.children[id] = child;
		self.setState(id,{status: "starting", pid: String(child.pid || "")});
		child.on("error",function(err) {
			self.log(id,"Process error: " + err.message);
		});
		child.on("exit",function(code,signal) {
			if(self.children[id] === child) {
				delete self.children[id];
			}
			self.log(id,"Server process exited" + (signal ? " (" + signal + ")" : " with code " + code));
			self.setState(id,{status: code && !child.stopRequested ? "error" : "stopped", pid: ""});
		});
		return self.waitUntilUp(server,child);
	}).then(function() {
		return "Server running at " + url;
	});
};

MwsManager.prototype.waitUntilUp = function(server,child) {
	var self = this,
		url = this.getUrl(server),
		started = Date.now();
	var poll = function() {
		if(child && child.exitCode !== null) {
			return Promise.reject(new Error("The server process exited. See the log for details."));
		}
		return ping(url).then(function(up) {
			if(up) {
				self.setState(server.id,{status: "running"});
				return;
			}
			if(Date.now() - started > STARTUP_TIMEOUT) {
				throw new Error("The server did not answer at " + url + " within " + (STARTUP_TIMEOUT / 1000) + " seconds");
			}
			return delay(1000).then(poll);
		});
	};
	return poll();
};

MwsManager.prototype.stopServer = function(server) {
	var self = this,
		id = server.id;
	if(server.kind === "ssh") {
		return this.getRunner(server).shellInDataPath(this.getSshStopCommand(server),this.logger(id)).then(function(result) {
			check(result,"Stop command");
			return "Server stopped";
		});
	}
	var child = this.children[id];
	if(!child) {
		return this.checkStatus(id).then(function(up) {
			if(up && server.kind === "local") {
				throw new Error("The server was not started by TiddlyDesktop and cannot be stopped from here");
			}
			return "Server is not running";
		});
	}
	return new Promise(function(resolve) {
		var timer = setTimeout(function() {
			self.log(id,"Server did not stop in time, killing it");
			child.kill("SIGKILL");
		},15000);
		child.once("exit",function() {
			clearTimeout(timer);
			resolve("Server stopped");
		});
		child.stopRequested = true;
		self.setState(id,{status: "stopping"});
		child.kill();
	});
};

// Default commands for servers managed over ssh: run the server in the background and remember its pid
MwsManager.prototype.getSshStartCommand = function(server) {
	return server.sshStart || ("nohup node node_modules/@tiddlywiki/mws/mws.run.mjs listen --listener " +
		quotePosix("host=" + server.host) + " " + quotePosix("port=" + server.port) +
		" >> mws.log 2>&1 < /dev/null & echo $! > mws.pid");
};

MwsManager.prototype.getSshStopCommand = function(server) {
	return server.sshStop || "if [ -f mws.pid ]; then kill $(cat mws.pid) 2>/dev/null; rm -f mws.pid; fi";
};

MwsManager.prototype.fetchRemoteLog = function(id) {
	var self = this;
	return this.task(id,"Fetch server log",function(server) {
		if(server.kind !== "ssh") {
			throw new Error("Only available for servers managed over ssh");
		}
		return self.getRunner(server).shellInDataPath("tail -n 200 mws.log",self.logger(id)).then(function(result) {
			check(result,"tail");
		});
	});
};

MwsManager.prototype.hasRunningServers = function() {
	return Object.keys(this.children).length > 0;
};

// Stop all servers started by this TiddlyDesktop instance, synchronously, eg when quitting
MwsManager.prototype.killAll = function() {
	var self = this;
	Object.keys(this.children).forEach(function(id) {
		try {
			self.children[id].stopRequested = true;
			self.children[id].kill();
		} catch(e) {}
	});
};

// #endregion

// #region Install

/*
Install a new MWS instance
params.caption: name of the server
params.kind: "local" or "ssh"
params.parent: (local) folder in which the data folder is created
params.folder: name of the data folder (local) or path of the data folder on the remote host (ssh)
params.host, params.port: listener settings
params.ssh-target, params.ssh-port, params.ssh-prefix: ssh settings
params.url: optional public URL
*/
MwsManager.prototype.install = function(params) {
	var self = this,
		kind = params.kind === "ssh" ? "ssh" : "local",
		fields = {
			caption: params.caption || "MWS",
			"mws-kind": kind,
			"mws-host": params.host || (kind === "ssh" ? "0.0.0.0" : "localhost"),
			"mws-port": params.port || this.suggestPort(),
			"mws-url": params.url || "",
			"mws-autostart": params.autostart === "yes" ? "yes" : "no"
		};
	if(kind === "local") {
		if(!params.parent || !params.folder) {
			return Promise.reject(new Error("Choose a parent folder and a folder name"));
		}
		fields["mws-path"] = path.resolve(params.parent,params.folder);
		if(fs.existsSync(fields["mws-path"])) {
			this.alert("The folder " + fields["mws-path"] + " already exists. Choose another name, or use \"Add existing\" for an existing MWS folder.");
			return Promise.resolve();
		}
	} else {
		if(!params["ssh-target"] || !params.folder) {
			this.alert("Enter the ssh target (user@host) and the data folder on the remote host");
			return Promise.resolve();
		}
		fields["mws-path"] = params.folder;
		fields["ssh-target"] = params["ssh-target"];
		fields["ssh-port"] = params["ssh-port"] || "";
		fields["ssh-prefix"] = params["ssh-prefix"] || "";
	}
	var id = this.addServer(fields);
	return this.task(id,"Install MWS",function(server) {
		var log = self.logger(id),
			r = self.getRunner(server),
			createArgs = ["exec","--yes","--package=" + CREATE_PACKAGE,"--","create-mws"];
		var install;
		if(kind === "local") {
			// create-mws creates the folder, installs MWS, downloads TiddlyWiki and initialises the store
			install = r.npm(createArgs.concat([server.path]),log,path.dirname(server.path)).then(function(result) {
				check(result,"npm");
				if(!r.isInstalled() || !fs.existsSync(r.resolve("store","database.sqlite"))) {
					throw new Error("Installation incomplete, see the log for details");
				}
			});
		} else {
			install = r.shell("npm " + createArgs.concat([server.path]).map(quotePosix).join(" "),log).then(function(result) {
				check(result,"npm");
				return r.shell("test -f " + quotePosix(r.remotePath("node_modules","@tiddlywiki","mws","mws.run.mjs")) +
					" && test -f " + quotePosix(r.remotePath("store","database.sqlite")),log);
			}).then(function(result) {
				if(result.code !== 0) {
					throw new Error("Installation incomplete, see the log for details");
				}
			});
		}
		return install.then(function() {
			log("");
			log("MWS has been installed. The initial login is username \"admin\" with password \"1234\".");
			log("Change this password right after the first login (open the admin page, then your profile).");
			return "Installed. Log in as admin / 1234 and change the password.";
		});
	});
};

/*
Register an existing MWS data folder on this computer
*/
MwsManager.prototype.addExisting = function(folder,params) {
	params = params || {};
	var pkg = readJson(path.resolve(folder,"package.json"));
	if(!pkg || pkg.name !== INSTANCE_PACKAGE_NAME) {
		this.alert("\"" + folder + "\" is not an MWS data folder (its package.json must be named " + INSTANCE_PACKAGE_NAME + ")");
		return null;
	}
	var id = this.addServer({
		caption: params.caption || path.basename(folder),
		"mws-kind": "local",
		"mws-path": folder,
		"mws-host": params.host || "localhost",
		"mws-port": params.port || this.suggestPort()
	});
	this.refreshBackups(id);
	this.checkStatus(id);
	return id;
};

MwsManager.prototype.addSsh = function(params) {
	if(!params["ssh-target"] || !params.folder) {
		this.alert("Enter the ssh target (user@host) and the data folder on the remote host");
		return null;
	}
	var id = this.addServer({
		caption: params.caption || params["ssh-target"],
		"mws-kind": "ssh",
		"mws-path": params.folder,
		"mws-host": params.host || "0.0.0.0",
		"mws-port": params.port || "8080",
		"mws-url": params.url || "",
		"ssh-target": params["ssh-target"],
		"ssh-port": params["ssh-port"] || "",
		"ssh-prefix": params["ssh-prefix"] || ""
	});
	this.refreshBackups(id);
	this.checkStatus(id);
	return id;
};

MwsManager.prototype.addRemote = function(params) {
	if(!params.url) {
		this.alert("Enter the URL of the server");
		return null;
	}
	var id = this.addServer({
		caption: params.caption || params.url,
		"mws-kind": "remote",
		"mws-url": params.url
	});
	this.checkStatus(id);
	return id;
};

MwsManager.prototype.remove = function(id) {
	var self = this,
		finish = function() {
			$tw.wiki.deleteTiddler(SERVER_PREFIX + id);
			$tw.wiki.deleteTiddler(STATE_PREFIX + id);
			$tw.wiki.deleteTiddler(LOG_PREFIX + id);
			self.clearBackupTiddlers(id);
		};
	if(this.children[id]) {
		return this.stopServer(this.getServer(id)).then(finish);
	}
	finish();
	return Promise.resolve();
};

// Reinstall node_modules from package-lock.json and download missing TiddlyWiki versions
MwsManager.prototype.repair = function(id) {
	var self = this;
	return this.task(id,"Repair installation",function(server) {
		if(server.kind === "remote") {
			throw new Error("Not available for remote servers");
		}
		var r = self.getRunner(server),
			log = self.logger(id);
		return r.npm(["ci"],log).then(function(result) {
			check(result,"npm ci");
			return self.readVersionsTxt(server);
		}).then(function(versions) {
			return self.installTiddlyWikiVersions(server,versions);
		});
	});
};

// #endregion

// #region Updates

MwsManager.prototype.checkForUpdates = function(id) {
	var self = this;
	return this.task(id,"Check for updates",function(server) {
		var r = self.getRunner(server),
			log = self.logger(id),
			installed;
		var getInstalled = server.kind === "ssh" ?
			r.shellInDataPath("node -p \"require('./node_modules/@tiddlywiki/mws/package.json').version\"").then(function(result) {
				return result.code === 0 ? result.output.trim() : "";
			}) :
			Promise.resolve((readJson(r.resolve("node_modules","@tiddlywiki","mws","package.json")) || {}).version || "");
		return getInstalled.then(function(version) {
			installed = version;
			return r.npm(["view",MWS_PACKAGE,"version"],null);
		}).then(function(result) {
			check(result,"npm view");
			var latest = result.output.trim().split("\n").pop();
			self.setState(id,{"mws-version": installed, "mws-latest": latest});
			log("Installed MWS version: " + (installed || "unknown") + ", latest published version: " + latest);
			return installed === latest ? "MWS " + installed + " is up to date" : "MWS " + latest + " is available (installed: " + (installed || "unknown") + ")";
		});
	});
};

/*
Update MWS within the version range allowed by package.json, restarting the server if it was running
*/
MwsManager.prototype.updateMws = function(id) {
	var self = this;
	return this.task(id,"Update MWS",function(server) {
		var r = self.getRunner(server),
			log = self.logger(id);
		return self.withServerStopped(server,function() {
			return self.maybeBackupBeforeUpdate(server).then(function() {
				return r.npm(["update",MWS_PACKAGE],log);
			}).then(function(result) {
				check(result,"npm update");
			});
		}).then(function() {
			return "MWS updated. Database changes are applied when the server starts.";
		});
	});
};

MwsManager.prototype.updateTiddlyWiki = function(id) {
	var self = this;
	return this.task(id,"Update TiddlyWiki",function(server) {
		var r = self.getRunner(server),
			log = self.logger(id);
		return self.maybeBackupBeforeUpdate(server).then(function() {
			return r.mws(["update-tiddlywiki"],log);
		}).then(function(result) {
			if(/folder already exists/.test(result.output)) {
				return "TiddlyWiki is already up to date";
			}
			check(result,"update-tiddlywiki");
			return "TiddlyWiki updated. Restart the server to use the new version.";
		});
	});
};

MwsManager.prototype.maybeBackupBeforeUpdate = function(server) {
	if(!server.backupBeforeUpdate) {
		return Promise.resolve();
	}
	this.log(server.id,"Creating a backup before updating...");
	return this.createBackup(server,"before-update");
};

/*
Run fn with the server stopped, restarting it afterwards if it was running
*/
MwsManager.prototype.withServerStopped = function(server,fn) {
	var self = this,
		wasRunning;
	return this.checkStatus(server.id).then(function(up) {
		wasRunning = up;
		if(up && server.kind === "local" && !self.children[server.id]) {
			throw new Error("The server is running outside TiddlyDesktop. Stop it first.");
		}
		if(up) {
			self.log(server.id,"Stopping the server...");
			return self.stopServer(server);
		}
	}).then(function() {
		return fn();
	}).then(function(value) {
		if(wasRunning) {
			self.log(server.id,"Starting the server again...");
			return self.startServer(server).then(function() {return value;});
		}
		return value;
	});
};

// #endregion

// #region Backups

MwsManager.prototype.backup = function(id) {
	var self = this;
	return this.task(id,"Backup",function(server) {
		return self.createBackup(server,"").then(function(folder) {
			return "Backup saved to " + folder;
		});
	});
};

/*
Create a backup and return the path of the backup folder
*/
MwsManager.prototype.createBackup = function(server,label) {
	var self = this,
		id = server.id,
		log = this.logger(id),
		root = this.getBackupFolder(server),
		baseName = "mws-backup-" + timestamp() + (label ? "-" + label : ""),
		name = baseName,
		args = ["backup-store"],
		r = this.getRunner(server);
	if(server.kind === "remote") {
		return Promise.reject(new Error("Backups need access to the data folder. Add the server as an ssh server to back it up."));
	}
	for(var n = 2; fs.existsSync(path.resolve(root,name)); n++) {
		name = baseName + "-" + n;
	}
	var dest = path.resolve(root,name);
	$tw.utils.createDirectory(root);
	var options = server.backupPasswordsKey ? ["--json"] : ["--json","--skip-passwords-key"];
	var promise;
	if(server.kind === "local") {
		promise = r.mws(args.concat([dest],options),log).then(function(result) {
			if(isUnknownCommand(result,"backup-store")) {
				log("This MWS version has no backup-store command, copying the data folder instead");
				return self.copyBackup(server,dest);
			}
			check(result,"backup-store");
		});
	} else {
		var remoteTemp = r.remotePath(".td-" + name);
		promise = r.mws(args.concat([remoteTemp],options),log).then(function(result) {
			if(isUnknownCommand(result,"backup-store")) {
				throw new Error("The MWS version on the server has no backup-store command. Update MWS first.");
			}
			check(result,"backup-store");
			log("Downloading the backup...");
			return r.download(remoteTemp,dest,log);
		}).then(function(result) {
			check(result,"scp");
		}).then(function() {
			return r.shell("rm -rf " + quotePosix(remoteTemp),log);
		},function(err) {
			return r.shell("rm -rf " + quotePosix(remoteTemp),log).then(function() {throw err;});
		});
	}
	return promise.then(function() {
		if(!fs.existsSync(path.resolve(dest,"mws-backup.json"))) {
			throw new Error("The backup is incomplete: mws-backup.json is missing");
		}
		log("Backup saved to " + dest);
		self.pruneBackups(server);
		self.refreshBackups(id);
		return dest;
	});
};

/*
Fallback for MWS versions without the backup-store command: copy the files with the server stopped
*/
MwsManager.prototype.copyBackup = function(server,dest) {
	var self = this,
		src = server.path;
	return this.withServerStopped(server,function() {
		var files = [];
		$tw.utils.createDirectory(dest);
		fs.cpSync(path.resolve(src,"store"),path.resolve(dest,"store"),{recursive: true});
		files.push("store");
		["package.json","package-lock.json",path.join("tw5","versions.txt")].concat(server.backupPasswordsKey ? ["passwords.key"] : []).forEach(function(rel) {
			if(fs.existsSync(path.resolve(src,rel))) {
				$tw.utils.createDirectory(path.dirname(path.resolve(dest,rel)));
				fs.copyFileSync(path.resolve(src,rel),path.resolve(dest,rel));
				files.push(rel.split(path.sep).join("/"));
			}
		});
		var pkg = readJson(path.resolve(src,"node_modules","@tiddlywiki","mws","package.json")) || {};
		fs.writeFileSync(path.resolve(dest,"mws-backup.json"),JSON.stringify({
			format: 1,
			created: new Date().toISOString(),
			mwsVersion: pkg.version || "unknown",
			wikiPath: src,
			includesPasswordsKey: server.backupPasswordsKey,
			files: files
		},null,2));
		self.log(server.id,"Copied " + files.join(", "));
	});
};

MwsManager.prototype.readBackups = function(server) {
	var root = this.getBackupFolder(server),
		backups = [];
	if(!fs.existsSync(root)) {
		return backups;
	}
	fs.readdirSync(root).forEach(function(name) {
		var manifest = readJson(path.resolve(root,name,"mws-backup.json"));
		if(manifest) {
			backups.push({name: name, path: path.resolve(root,name), manifest: manifest});
		}
	});
	backups.sort(function(a,b) {
		return a.manifest.created < b.manifest.created ? -1 : (a.manifest.created > b.manifest.created ? 1 : 0);
	});
	return backups;
};

MwsManager.prototype.clearBackupTiddlers = function(id) {
	$tw.wiki.filterTiddlers("[all[tiddlers]prefix[" + BACKUP_PREFIX + id + "/]]").forEach(function(title) {
		$tw.wiki.deleteTiddler(title);
	});
};

MwsManager.prototype.refreshBackups = function(id) {
	var server = this.getServer(id);
	this.clearBackupTiddlers(id);
	if(!server || server.kind === "remote") {
		return;
	}
	var backups = this.readBackups(server);
	backups.forEach(function(backup) {
		$tw.wiki.addTiddler({
			title: BACKUP_PREFIX + id + "/" + backup.name,
			server: id,
			name: backup.name,
			path: backup.path,
			created: $tw.utils.stringifyDate(new Date(backup.manifest.created)),
			"mws-version": backup.manifest.mwsVersion || "",
			"includes-passwords-key": backup.manifest.includesPasswordsKey ? "yes" : "no"
		});
	});
	this.setState(id,{"last-backup": backups.length ? $tw.utils.stringifyDate(new Date(backups[backups.length - 1].manifest.created)) : "", "backup-count": String(backups.length)});
};

// Delete the oldest backups beyond the configured number to keep
MwsManager.prototype.pruneBackups = function(server) {
	if(!server.backupKeep) {
		return;
	}
	var self = this,
		backups = this.readBackups(server);
	backups.slice(0,Math.max(0,backups.length - server.backupKeep)).forEach(function(backup) {
		self.log(server.id,"Deleting old backup " + backup.name);
		fs.rmSync(backup.path,{recursive: true, force: true});
	});
};

MwsManager.prototype.deleteBackup = function(id,name) {
	var server = this.getServer(id),
		folder = server && path.resolve(this.getBackupFolder(server),name);
	if(folder && fs.existsSync(path.resolve(folder,"mws-backup.json"))) {
		fs.rmSync(folder,{recursive: true, force: true});
	}
	this.refreshBackups(id);
};

MwsManager.prototype.revealBackups = function(id) {
	var server = this.getServer(id),
		folder = this.getBackupFolder(server);
	$tw.utils.createDirectory(folder);
	$tw.desktop.gui.Shell.openItem(folder);
};

// Backups that are due according to each server's backup interval
MwsManager.prototype.runScheduledBackups = function() {
	var self = this;
	this.getServerIds().forEach(function(id) {
		var server = self.getServer(id);
		if(!server || server.kind === "remote" || !server.backupInterval || self.busy[id]) {
			return;
		}
		var backups = self.readBackups(server),
			last = backups.length ? new Date(backups[backups.length - 1].manifest.created).getTime() : 0;
		if(Date.now() - last >= server.backupInterval * 3600 * 1000) {
			self.task(id,"Scheduled backup",function(server) {
				return self.createBackup(server,"scheduled").then(function(folder) {
					return "Scheduled backup saved to " + folder;
				});
			});
		}
	});
};

// #endregion

// #region Restore

MwsManager.prototype.readVersionsTxt = function(server,folder) {
	var filename = path.resolve(folder || server.path,"tw5","versions.txt");
	if(server.kind === "ssh" && !folder) {
		return this.getRunner(server).shellInDataPath("cat tw5/versions.txt").then(function(result) {
			return result.code === 0 ? result.output.split("\n").map(function(v) {return v.trim();}).filter(Boolean) : [];
		});
	}
	return Promise.resolve(fs.existsSync(filename) ? fs.readFileSync(filename,"utf8").split("\n").map(function(v) {return v.trim();}).filter(Boolean) : []);
};

// Download the TiddlyWiki versions that the store refers to but that are missing from the tw5 folder
MwsManager.prototype.installTiddlyWikiVersions = function(server,versions) {
	var r = this.getRunner(server),
		log = this.logger(server.id),
		installedLatest = false;
	var hasFolder = function(folder) {
		return server.kind === "ssh" ?
			r.shellInDataPath("test -d " + quotePosix(folder)).then(function(result) {return result.code === 0;}) :
			Promise.resolve(fs.existsSync(r.resolve(folder)));
	};
	var installLatest = function() {
		installedLatest = true;
		return r.mws(["update-tiddlywiki"],log).then(function(result) {
			if(!/folder already exists/.test(result.output)) {
				check(result,"update-tiddlywiki");
			}
		});
	};
	return versions.filter(function(version) {
		return /^[0-9A-Za-z.\-+]+$/.test(version);
	}).reduce(function(promise,version) {
		return promise.then(function() {
			return hasFolder("tw5/" + version);
		}).then(function(exists) {
			if(exists || installedLatest) {
				return;
			}
			log("Downloading TiddlyWiki " + version + "...");
			return r.mws(["update-tiddlywiki","--manual-version",version],log).then(function(result) {
				// Older MWS versions can only download the latest version
				if(/not a valid option/.test(result.output)) {
					log("This MWS version cannot download a specific TiddlyWiki version, downloading the latest version instead");
					return installLatest();
				}
				check(result,"update-tiddlywiki");
			});
		});
	},Promise.resolve()).then(function() {
		return hasFolder("tw5");
	}).then(function(exists) {
		if(!exists && !installedLatest) {
			log("Downloading TiddlyWiki...");
			return installLatest();
		}
	});
};

/*
Restore a backup into the data folder of a server. The current store folder is kept as store.before-restore-<timestamp>
*/
MwsManager.prototype.restore = function(id,name) {
	var self = this;
	return this.task(id,"Restore " + name,function(server) {
		var backupFolder = path.resolve(self.getBackupFolder(server),name),
			manifest = readJson(path.resolve(backupFolder,"mws-backup.json"));
		if(!manifest) {
			throw new Error("Not a backup folder: " + backupFolder);
		}
		return self.withServerStopped(server,function() {
			return server.kind === "ssh" ? self.restoreSsh(server,backupFolder) : self.restoreLocal(server,backupFolder);
		}).then(function() {
			return "Restored " + name + ". The previous store folder was kept as store.before-restore-...";
		});
	});
};

MwsManager.prototype.restoreLocal = function(server,backupFolder) {
	var self = this,
		r = this.getRunner(server),
		log = this.logger(server.id),
		stamp = timestamp(),
		lockChanged = !filesEqual(path.resolve(backupFolder,"package-lock.json"),r.resolve("package-lock.json"));
	if(fs.existsSync(r.resolve("store"))) {
		fs.renameSync(r.resolve("store"),r.resolve("store.before-restore-" + stamp));
		log("Moved the current store to store.before-restore-" + stamp);
	}
	fs.cpSync(path.resolve(backupFolder,"store"),r.resolve("store"),{recursive: true});
	["package.json","package-lock.json"].forEach(function(rel) {
		if(fs.existsSync(path.resolve(backupFolder,rel))) {
			fs.copyFileSync(path.resolve(backupFolder,rel),r.resolve(rel));
		}
	});
	if(fs.existsSync(path.resolve(backupFolder,"passwords.key")) && !filesEqual(path.resolve(backupFolder,"passwords.key"),r.resolve("passwords.key"))) {
		if(fs.existsSync(r.resolve("passwords.key"))) {
			fs.renameSync(r.resolve("passwords.key"),r.resolve("passwords.key.before-restore-" + stamp));
		}
		fs.copyFileSync(path.resolve(backupFolder,"passwords.key"),r.resolve("passwords.key"));
		log("Restored passwords.key");
	} else if(!fs.existsSync(path.resolve(backupFolder,"passwords.key"))) {
		log("The backup has no passwords.key, the existing one is kept. If it differs from the original, passwords must be reset.");
	}
	var step = Promise.resolve();
	if(lockChanged || !r.isInstalled()) {
		step = step.then(function() {
			log("Installing the MWS version from the backup (npm ci)...");
			return r.npm(["ci"],log);
		}).then(function(result) {
			check(result,"npm ci");
		});
	}
	return step.then(function() {
		return self.readVersionsTxt(server,backupFolder);
	}).then(function(versions) {
		return self.installTiddlyWikiVersions(server,versions);
	});
};

MwsManager.prototype.restoreSsh = function(server,backupFolder) {
	var self = this,
		r = this.getRunner(server),
		log = this.logger(server.id),
		stamp = timestamp(),
		remoteTemp = r.remotePath(".td-restore-" + stamp),
		t = quotePosix(".td-restore-" + stamp);
	log("Uploading the backup...");
	return r.upload(backupFolder,remoteTemp,log).then(function(result) {
		check(result,"scp");
		return r.shellInDataPath([
			"set -e",
			"if [ -d store ]; then mv store store.before-restore-" + stamp + "; fi",
			"cp -R " + t + "/store store",
			"cp " + t + "/package.json .",
			"if [ -f " + t + "/package-lock.json ]; then cp " + t + "/package-lock.json .; fi",
			"if [ -f " + t + "/passwords.key ] && ! cmp -s " + t + "/passwords.key passwords.key; then if [ -f passwords.key ]; then mv passwords.key passwords.key.before-restore-" + stamp + "; fi; cp " + t + "/passwords.key .; fi",
			"rm -rf " + t,
			"npm ci"
		].join("; "),log);
	}).then(function(result) {
		check(result,"restore");
		return self.readVersionsTxt(server,backupFolder);
	}).then(function(versions) {
		return self.installTiddlyWikiVersions(server,versions);
	});
};

/*
Create a new local instance from a backup, eg to move a server to this computer
*/
MwsManager.prototype.restoreAsNew = function(id,name,parent,folderName) {
	var self = this,
		source = this.getServer(id),
		backupFolder = path.resolve(this.getBackupFolder(source),name),
		dest = path.resolve(parent,folderName);
	if(fs.existsSync(dest)) {
		this.alert("The folder " + dest + " already exists");
		return Promise.resolve();
	}
	var newId = this.addServer({
		caption: source.name + " (restored)",
		"mws-kind": "local",
		"mws-path": dest,
		"mws-host": "localhost",
		"mws-port": this.suggestPort()
	});
	return this.task(newId,"Restore " + name + " as a new instance",function(server) {
		$tw.utils.createDirectory(dest);
		return self.restoreLocal(server,backupFolder).then(function() {
			return "Restored into " + dest;
		});
	});
};

// #endregion

// #region Windows

MwsManager.prototype.openAdmin = function(id,pathname) {
	var server = this.getServer(id);
	if(!server) {
		return;
	}
	var url = this.getUrl(server) + (pathname || "").replace(/^\/+/,"");
	$tw.desktop.gui.Window.open(url,{
		id: "mws-" + id + "-" + (pathname || "admin"),
		width: 1200,
		height: 800,
		icon: "images/app_icon.png"
	},function(win) {
		win.once("loaded",function() {
			$tw.desktop.utils.devtools.trapDevTools(win,win.window.document);
			$tw.desktop.utils.menu.createMenuBar(win);
		});
	});
};

MwsManager.prototype.openInBrowser = function(id) {
	var server = this.getServer(id);
	if(server) {
		$tw.desktop.gui.Shell.openExternal(this.getUrl(server));
	}
};

MwsManager.prototype.revealFolder = function(id) {
	var server = this.getServer(id);
	if(server && server.kind === "local" && fs.existsSync(server.path)) {
		$tw.desktop.gui.Shell.openItem(server.path);
	}
};

// #endregion

// #region Lifecycle

MwsManager.prototype.init = function() {
	var self = this;
	this.getServerIds().forEach(function(id) {
		$tw.wiki.deleteTiddler(STATE_PREFIX + id);
		self.setState(id,{status: "unknown"});
		self.refreshBackups(id);
	});
	this.checkEnvironment();
	this.checkAll().then(function() {
		self.getServerIds().forEach(function(id) {
			var server = self.getServer(id);
			if(server.autostart && server.kind !== "remote" && self.getState(id).status !== "running" && self.getState(id).status !== "external") {
				self.start(id);
			}
		});
	});
	this.timer = setInterval(function() {
		self.checkAll().then(function() {
			self.runScheduledBackups();
		});
	},SCHEDULER_INTERVAL);
	// Make sure servers started by us do not outlive TiddlyDesktop
	process.on("exit",function() {
		self.killAll();
	});
};

// #endregion

exports.MwsManager = MwsManager;
