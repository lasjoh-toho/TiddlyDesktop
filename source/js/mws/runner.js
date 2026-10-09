/*
Runners execute commands for a MultiWikiServer (MWS) instance, either on this computer or on a remote host via ssh
*/

"use strict";

var childProcess = require("child_process"),
	fs = require("fs"),
	os = require("os"),
	path = require("path");

var isWindows = process.platform === "win32";

// Folders where node and npm are commonly installed but that are often missing from the PATH of GUI apps
var EXTRA_PATH_FOLDERS = isWindows ? [
	process.env.ProgramFiles && path.join(process.env.ProgramFiles,"nodejs"),
	process.env.APPDATA && path.join(process.env.APPDATA,"npm")
] : [
	"/usr/local/bin",
	"/opt/homebrew/bin",
	"/usr/bin",
	path.join(os.homedir(),".volta","bin"),
	path.join(os.homedir(),".local","bin")
];

/*
Build the environment for child processes
nodeFolder: optional folder containing node and npm, placed first on the PATH
*/
function buildEnv(nodeFolder) {
	var env = Object.assign({},process.env),
		pathKey = Object.keys(env).find(function(k) {return k.toUpperCase() === "PATH";}) || "PATH",
		parts = (env[pathKey] || "").split(path.delimiter).filter(Boolean);
	EXTRA_PATH_FOLDERS.forEach(function(folder) {
		if(folder && parts.indexOf(folder) === -1 && fs.existsSync(folder)) {
			parts.push(folder);
		}
	});
	if(nodeFolder) {
		parts.unshift(nodeFolder);
	}
	env[pathKey] = parts.join(path.delimiter);
	// Keep output free of colour codes so that it reads well in the log
	env.NO_COLOR = "1";
	env.FORCE_COLOR = "0";
	return env;
}

// Quote an argument for a POSIX shell
function quotePosix(arg) {
	arg = String(arg);
	if(/^[A-Za-z0-9_\/\.\-=:@%+,]+$/.test(arg)) {
		return arg;
	}
	return "'" + arg.replace(/'/g,"'\\''") + "'";
}

// Quote an argument for cmd.exe
function quoteWindows(arg) {
	arg = String(arg);
	if(/^[A-Za-z0-9_\\\/\.\-=:@%+,]+$/.test(arg)) {
		return arg;
	}
	return "\"" + arg.replace(/"/g,"\"\"") + "\"";
}

/*
Run a command, streaming its output line by line
options.cwd: working directory
options.env: environment
options.shell: run through the shell (needed for npm on Windows)
options.onLine: function(line,stream) called for each line of output
Returns a promise resolving to {code: exit code, output: combined output}
*/
function run(command,args,options) {
	options = options || {};
	return new Promise(function(resolve,reject) {
		var output = [],
			child;
		try {
			if(options.shell) {
				var quote = isWindows ? quoteWindows : quotePosix;
				child = childProcess.spawn([quote(command)].concat(args.map(quote)).join(" "),[],{
					cwd: options.cwd,
					env: options.env,
					shell: true,
					windowsHide: true
				});
			} else {
				child = childProcess.spawn(command,args,{
					cwd: options.cwd,
					env: options.env,
					windowsHide: true
				});
			}
		} catch(e) {
			return reject(e);
		}
		if(child.stdin) {
			child.stdin.end();
		}
		attachLineReader(child,function(line,stream) {
			output.push(line);
			if(options.onLine) {
				options.onLine(line,stream);
			}
		});
		child.on("error",function(err) {
			reject(err);
		});
		child.on("close",function(code) {
			resolve({code: code, output: output.join("\n")});
		});
	});
}

// Call fn(line,streamName) for each line written to stdout or stderr of a child process
function attachLineReader(child,fn) {
	["stdout","stderr"].forEach(function(name) {
		var stream = child[name],
			buffer = "";
		if(!stream) {
			return;
		}
		stream.setEncoding("utf8");
		stream.on("data",function(chunk) {
			buffer += chunk;
			var lines = buffer.split(/\r?\n/);
			buffer = lines.pop();
			lines.forEach(function(line) {
				fn(line,name);
			});
		});
		stream.on("end",function() {
			if(buffer) {
				fn(buffer,name);
				buffer = "";
			}
		});
	});
}

/*
Runner for an MWS data folder on this computer
*/
function LocalRunner(options) {
	this.dataPath = options.dataPath;
	this.env = buildEnv(options.nodeFolder);
}

LocalRunner.prototype.kind = "local";

LocalRunner.prototype.resolve = function(/* parts */) {
	return path.resolve.apply(path,[this.dataPath].concat(Array.prototype.slice.call(arguments)));
};

LocalRunner.prototype.mwsScript = function() {
	return this.resolve("node_modules","@tiddlywiki","mws","mws.run.mjs");
};

LocalRunner.prototype.isInstalled = function() {
	return fs.existsSync(this.mwsScript());
};

// Run the mws command line in the data folder
LocalRunner.prototype.mws = function(args,onLine) {
	return run("node",[this.mwsScript()].concat(args),{cwd: this.dataPath, env: this.env, onLine: onLine});
};

// Run npm, by default in the data folder
LocalRunner.prototype.npm = function(args,onLine,cwd) {
	return run("npm",args,{cwd: cwd || this.dataPath, env: this.env, shell: isWindows, onLine: onLine});
};

/*
Start the server as a long running child process
Returns the ChildProcess
*/
LocalRunner.prototype.spawnListen = function(listenerArgs,onLine) {
	var child = childProcess.spawn("node",[this.mwsScript(),"listen","--listener"].concat(listenerArgs),{
		cwd: this.dataPath,
		env: this.env,
		windowsHide: true
	});
	if(child.stdin) {
		child.stdin.end();
	}
	attachLineReader(child,onLine);
	return child;
};

/*
Runner for an MWS data folder on a remote host reachable with ssh
Authentication must work without prompts (eg an ssh key loaded into the agent)
*/
function SshRunner(options) {
	this.target = options.target;
	this.port = options.port;
	this.dataPath = options.dataPath;
	this.prefix = options.prefix || "";
	this.env = buildEnv(options.nodeFolder);
}

SshRunner.prototype.kind = "ssh";

SshRunner.prototype.sshArgs = function() {
	var args = ["-o","BatchMode=yes","-o","ConnectTimeout=15"];
	if(this.port) {
		args.push("-p",String(this.port));
	}
	return args;
};

// Run a shell command line on the remote host
SshRunner.prototype.shell = function(commandLine,onLine) {
	var full = (this.prefix ? this.prefix + " && " : "") + commandLine;
	return run("ssh",this.sshArgs().concat([this.target,full]),{env: this.env, onLine: onLine});
};

// Run a shell command line on the remote host inside the data folder
SshRunner.prototype.shellInDataPath = function(commandLine,onLine) {
	// The braces make sure that "&" in the command line only puts that command in the background
	return this.shell("cd " + quotePosix(this.dataPath) + " && {\n" + commandLine + "\n}",onLine);
};

SshRunner.prototype.mws = function(args,onLine) {
	return this.shellInDataPath("node node_modules/@tiddlywiki/mws/mws.run.mjs " + args.map(quotePosix).join(" "),onLine);
};

SshRunner.prototype.npm = function(args,onLine) {
	return this.shellInDataPath("npm " + args.map(quotePosix).join(" "),onLine);
};

SshRunner.prototype.remotePath = function(/* parts */) {
	return [this.dataPath].concat(Array.prototype.slice.call(arguments)).join("/");
};

SshRunner.prototype.scpArgs = function() {
	var args = ["-o","BatchMode=yes","-o","ConnectTimeout=15","-r"];
	if(this.port) {
		args.push("-P",String(this.port));
	}
	return args;
};

// Copy a remote folder to a local folder that must not exist yet
SshRunner.prototype.download = function(remoteFolder,localFolder,onLine) {
	return run("scp",this.scpArgs().concat([this.target + ":" + remoteFolder,localFolder]),{env: this.env, onLine: onLine});
};

// Copy a local folder to a remote folder that must not exist yet
SshRunner.prototype.upload = function(localFolder,remoteFolder,onLine) {
	return run("scp",this.scpArgs().concat([localFolder,this.target + ":" + remoteFolder]),{env: this.env, onLine: onLine});
};

exports.run = run;
exports.buildEnv = buildEnv;
exports.quotePosix = quotePosix;
exports.LocalRunner = LocalRunner;
exports.SshRunner = SshRunner;
