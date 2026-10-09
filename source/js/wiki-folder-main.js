/*
Script for wiki folder windows
*/

"use strict";

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

// Set up the $tw global
var $tw = {desktop: {
	gui: gui,
	utils: {
		devtools: require("../js/utils/devtools.js"),
		dom: require("../js/utils/dom.js"),
		menu: require("../js/utils/menu.js")
	}
}};

global.$tw = $tw;
window.$tw = $tw;

// Use the main window as the container window
var containerWindow = gui.Window.get();
// containerWindow.showDevTools();

// Hide the container window when we start, and when it is closed
containerWindow.on("close",function(isQuitting) {
	containerWindow.close(true);
});

$tw.desktop.utils.menu.createMenuBar(containerWindow);

// Show dev tools on F12
$tw.desktop.utils.devtools.trapDevTools(containerWindow,document);

// Get the query parameters that were used to open this container window

var queryObject = $tw.desktop.utils.dom.decodeQueryString(containerWindow.window.document.location);

// First part of boot process
require("../tiddlywiki/boot/bootprefix.js").bootprefix($tw);

// Set command line
$tw.boot = $tw.boot || {};
$tw.boot.argv = [queryObject.pathname];

if(queryObject.host && queryObject.port) {
	$tw.boot.argv.push("--listen","host="+queryObject.host,"port="+queryObject.port,"credentials="+queryObject.credentials,"readers="+queryObject.readers,"writers="+queryObject.writers);
}

console.log("Running tiddlywiki " + $tw.boot.argv.join(" "));

// Main part of boot process
require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);

$tw.wiki.addTiddler({title: "$:/status/IsReadOnly",text: "no"});

// Keep the wiki in sync with a MultiWikiServer if it is linked to one
if(queryObject.mwssync) {
	(function() {
		var settings = JSON.parse(queryObject.mwssync),
			client = require("../js/mws/client.js"),
			SyncEngine = require("../js/mws/sync.js").SyncEngine,
			sessions = new client.SessionStore(settings.dataPath),
			stateFolder = path.resolve(settings.dataPath,"mws-sync"),
			statusFile = path.resolve(stateFolder,settings.id + ".status.json"),
			triggerFile = path.resolve(stateFolder,settings.id + ".trigger");
		var engine = new SyncEngine({
			id: settings.id,
			wiki: $tw.wiki,
			Tiddler: $tw.Tiddler,
			baseUrl: settings.baseUrl,
			recipe: settings.recipe,
			getSession: function() {
				var entry = sessions.get(settings.serverId);
				return entry ? entry.session : null;
			},
			stateFolder: stateFolder,
			interval: settings.interval,
			initialMode: settings.initialMode,
			// The main TiddlyDesktop process reads this file to show the status in the wiki list
			onStatus: function(status) {
				status.updated = String(Date.now());
				fs.mkdirSync(stateFolder,{recursive: true});
				fs.writeFileSync(statusFile,JSON.stringify(status));
			},
			log: function(line) {
				console.log("[MWS sync] " + line);
			}
		});
		engine.start();
		// "Sync now" in the wiki list creates the trigger file
		setInterval(function() {
			if(fs.existsSync(triggerFile)) {
				fs.rmSync(triggerFile,{force: true});
				engine.syncNow();
			}
		},2000);
	})();
}
