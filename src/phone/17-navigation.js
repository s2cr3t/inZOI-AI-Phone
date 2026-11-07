    // ------------------------------------------------------------------
    // Navigation and refresh
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // App registry
    // ------------------------------------------------------------------
    // Every app the phone can hold is registered here once. The home screen (APPS, HOME_DOCK),
    // page titles (TITLES), pages (screens), icons and the App Store all read the registry, so a
    // new app is one registerApp call plus its own load/render functions and icon class:
    //   registerApp({
    //       id: 'notes',                 // also the page opened from the icon (or launch: '<page>')
    //       label: 'Notes',              // name under the icon and in the App Store
    //       cls: 'ic-notes',             // icon background, a class in index.html
    //       glyph: function () {},       // optional: draws the icon (else appGlyph's own drawing)
    //       category: 'Productivity',    // App Store
    //       desc: 'Quick notes.',        // App Store: one line in the list
    //       subtitle: '...', about: '...', whatsNew: '...', version: '1.0', developer: '...',
    //       featured: 'A headline',      // App Store: the app can be the featured card
    //       system: false,               // true: always on the phone, cannot be removed
    //       preinstalled: true,          // on the phone the first time this app is seen
    //       dock: false,                 // in the dock under the pages instead of on a page
    //       badge: function (homeData) { return 0; },   // optional number on the icon
    //       screens: {                   // every page of the app
    //           notes: { load: loadNotes, render: renderNotes, title: 'Notes' },
    //           note: { load: loadNote, render: renderNote, parent: 'notes' }   // Back goes to parent
    //       }
    //   });
    // Which apps are on the phone is kept in saved/apps.cfg: { v, installed: [ids], known: [ids] }.
    // "known" lets an app added in a later version install itself once (when preinstalled), while
    // an app the player removed stays removed.
    var APP_STORE_KEY = 'apps';
    var appRegistry = {};
    var appOrder = [];
    var screenApp = {};
    var screenParent = {};
    var appsInstalled = null;
    var appsKnown = null;
    var appsLoaded = false;
    var screens = {};

    function registerApp(def) {
        if (!def || !def.id || appRegistry[def.id]) return;
        var app = {
            id: def.id,
            label: def.label || def.id,
            cls: def.cls || '',
            glyph: typeof def.glyph === 'function' ? def.glyph : null,
            category: def.category || '',
            desc: def.desc || '',
            // App Store page: a short line under the name, the full text, and what changed last.
            subtitle: def.subtitle || def.desc || '',
            about: def.about || def.desc || '',
            whatsNew: def.whatsNew || '',
            developer: def.developer || 'HouseholdBoard',
            featured: def.featured || '',
            version: def.version || '',
            system: !!def.system,
            preinstalled: def.preinstalled !== false,
            dock: !!def.dock,
            badge: typeof def.badge === 'function' ? def.badge : null,
            launch: def.launch || def.id,
            screens: def.screens || {}
        };
        appRegistry[app.id] = app;
        appOrder.push(app.id);
        Object.keys(app.screens).forEach(function (sid) {
            var s = app.screens[sid];
            if (!s || typeof s.load !== 'function' || typeof s.render !== 'function') return;
            screens[sid] = { load: s.load, render: s.render };
            screenApp[sid] = app.id;
            if (s.parent) screenParent[sid] = s.parent;
            TITLES[sid] = s.title || (sid === app.launch ? app.label : TITLES[sid] || '');
        });
        appsRebuild();
    }

    function appInstalled(id) {
        var app = appRegistry[id];
        if (!app) return false;
        if (app.system) return true;
        return appsInstalled ? appsInstalled.indexOf(id) >= 0 : app.preinstalled;
    }

    // The app a page belongs to ('home' and unknown pages belong to none).
    function appOfScreen(screenId) { return screenApp[screenId] || ''; }

    // APPS and HOME_DOCK, the installed apps in registration order.
    function appsRebuild() {
        APPS.length = 0;
        HOME_DOCK.length = 0;
        appOrder.forEach(function (id) {
            var app = appRegistry[id];
            if (!appInstalled(id)) return;
            APPS.push(app);
            if (app.dock) HOME_DOCK.push(id);
        });
    }

    function appsSave() {
        if (!appsLoaded) return;
        saveJson(APP_STORE_KEY, { v: 1, installed: appsInstalled.slice(), known: appsKnown.slice() }, SOUND_SECTION)
            .then(null, function () {});
    }

    // Reads saved/apps.cfg once at start. Until it is read every preinstalled app is shown.
    function appsLoad() {
        return cfgValue(SOUND_SECTION, APP_STORE_KEY).then(function (v) {
            var saved = v && Array.isArray(v.installed) ? v : null;
            var installed = [];
            var known = saved && Array.isArray(saved.known) ? saved.known.slice() : [];
            appOrder.forEach(function (id) {
                var app = appRegistry[id];
                var wasKnown = known.indexOf(id) >= 0 || (saved && !saved.known);
                if (app.system || (saved && saved.installed.indexOf(id) >= 0) || (!wasKnown && app.preinstalled) || (!saved && app.preinstalled)) {
                    installed.push(id);
                }
                if (known.indexOf(id) < 0) known.push(id);
            });
            appsInstalled = installed;
            appsKnown = known;
            appsLoaded = true;
            appsRebuild();
            appsSave();
            if (current === 'home') refresh();
        }, function () {
            appsLoaded = false;
        });
    }

    function appInstall(id) {
        var app = appRegistry[id];
        if (!app || !appsInstalled || appsInstalled.indexOf(id) >= 0) return;
        appsInstalled.push(id);
        appsRebuild();
        appsSave();
    }

    function appRemove(id) {
        var app = appRegistry[id];
        if (!app || app.system || !appsInstalled) return;
        appsInstalled = appsInstalled.filter(function (x) { return x !== id; });
        appsRebuild();
        appsSave();
    }

