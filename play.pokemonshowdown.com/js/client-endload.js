"use strict";

PS.libsLoaded.loaded();

// Permanent analytics leaderboard tab.
// Storage.whenPrefsLoaded fires after app init but after the lobby/rooms tab
// is already focused, so adding here keeps it as a background tab.
Storage.whenPrefsLoaded(function () {
	var room = app._addRoom('view-analytics', null, true, 'Leaderboard');
	app.updateSideRoom();
	app.updateLayout();
	room.join(); // fetch page content from server
});
//# sourceMappingURL=client-endload.js.map