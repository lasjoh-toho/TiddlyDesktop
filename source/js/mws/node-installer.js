/*
Download and unpack an official Node.js release into the TiddlyDesktop data folder

No administrator rights are needed and nothing outside the data folder is changed
*/

"use strict";

var crypto = require("crypto"),
	fs = require("fs"),
	https = require("https"),
	path = require("path"),
	runner = require("./runner.js");

var DIST_URL = "https://nodejs.org/dist/";

// Fetch a URL into a buffer, following redirects
function download(url,onProgress) {
	return new Promise(function(resolve,reject) {
		https.get(url,function(res) {
			if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				return resolve(download(new URL(res.headers.location,url).toString(),onProgress));
			}
			if(res.statusCode !== 200) {
				res.resume();
				return reject(new Error("Download of " + url + " failed with status " + res.statusCode));
			}
			var chunks = [],
				received = 0,
				total = parseInt(res.headers["content-length"],10) || 0,
				lastReport = 0;
			res.on("data",function(chunk) {
				chunks.push(chunk);
				received += chunk.length;
				if(onProgress && total && received - lastReport > total / 10) {
					lastReport = received;
					onProgress(Math.round(received * 100 / total) + "% of " + Math.round(total / 1048576) + " MB");
				}
			});
			res.on("end",function() {
				resolve(Buffer.concat(chunks));
			});
			res.on("error",reject);
		}).on("error",reject);
	});
}

// The file name of the release archive for this computer
function archiveName(version) {
	var platform = {darwin: "darwin", linux: "linux", win32: "win"}[process.platform],
		arch = {x64: "x64", arm64: "arm64"}[process.arch];
	if(!platform || !arch) {
		throw new Error("No Node.js download is available for " + process.platform + "/" + process.arch);
	}
	return "node-" + version + "-" + platform + "-" + arch + (platform === "win" ? ".zip" : ".tar.gz");
}

// The folder that contains the node and npm executables inside an unpacked release
function binFolder(folder) {
	return process.platform === "win32" ? folder : path.join(folder,"bin");
}

/*
Install the latest LTS release of Node.js into <dataPath>/nodejs
log: function(line)
Returns a promise for the folder containing the node and npm executables
*/
function installNode(dataPath,log) {
	var root = path.resolve(dataPath,"nodejs"),
		version, name;
	log("Looking up the latest Node.js LTS release...");
	return download(DIST_URL + "index.json").then(function(buffer) {
		var releases = JSON.parse(buffer.toString("utf8")),
			lts = releases.filter(function(r) {return r.lts;})[0];
		if(!lts) {
			throw new Error("Could not find a Node.js LTS release");
		}
		version = lts.version;
		name = archiveName(version);
		var existing = path.resolve(root,name.replace(/\.(zip|tar\.gz)$/,""));
		if(fs.existsSync(path.join(binFolder(existing),process.platform === "win32" ? "node.exe" : "node"))) {
			log("Node.js " + version + " is already installed");
			return null;
		}
		log("Downloading Node.js " + version + " (" + name + ")...");
		return Promise.all([
			download(DIST_URL + version + "/" + name,log),
			download(DIST_URL + version + "/SHASUMS256.txt")
		]);
	}).then(function(results) {
		var folder = path.resolve(root,name.replace(/\.(zip|tar\.gz)$/,""));
		if(!results) {
			return binFolder(folder);
		}
		var archive = results[0],
			sums = results[1].toString("utf8"),
			expected = (sums.split("\n").filter(function(line) {return line.trim().split(/\s+/)[1] === name;})[0] || "").split(/\s+/)[0],
			actual = crypto.createHash("sha256").update(archive).digest("hex");
		if(!expected || expected !== actual) {
			throw new Error("The checksum of the Node.js download does not match, aborting");
		}
		log("Checksum verified, unpacking...");
		fs.mkdirSync(root,{recursive: true});
		var archivePath = path.resolve(root,name);
		fs.writeFileSync(archivePath,archive);
		// tar is included with macOS, Linux and Windows 10 and newer, and can unpack zip files on Windows
		return runner.run("tar",["-xf",archivePath,"-C",root],{env: runner.buildEnv(), onLine: log}).then(function(result) {
			fs.rmSync(archivePath,{force: true});
			if(result.code !== 0) {
				throw new Error("Unpacking Node.js failed");
			}
			log("Node.js " + version + " installed in " + folder);
			return binFolder(folder);
		});
	});
}

exports.installNode = installNode;
