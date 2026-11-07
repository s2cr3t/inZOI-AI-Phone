    // ------------------------------------------------------------------
    // News: a local editorial preview. The stories and artwork are built in, so the app opens
    // without a network. A live open-source news feed can replace NW_STORIES later without
    // changing the page structure.
    // ------------------------------------------------------------------
    var NW_STORIES = [
        {
            id: 'night-train', cat: 'City', art: 'city', time: '6:10 AM', read: '7 min',
            byline: 'Mara Ellison', title: 'The 2 a.m. train that is quietly changing how the city works',
            standfirst: 'A year after the night line opened, the people who keep the city running say the biggest change is not the route. It is the hour.',
            body: [
                'At ten past two, the platform at East Market is almost empty. A baker in a flour-dusted jacket sits beside a nurse coming off a double shift. A cleaner charges her phone from the only free socket. Fifteen minutes later, the train arrives and the city begins its quiet second day.',
                'The night line was introduced as a modest transport experiment: four stations, one train every twenty minutes, and a promise to review the service after twelve months. Officials expected students and late diners. They did not expect the people who make the early city possible.',
                'Ridership figures released this week show the service carrying more passengers between two and four in the morning than it did during its first three months. The largest growth is among hospital staff, warehouse workers and bakers. For many, the train has turned an impossible commute into a twenty-minute nap.',
                'There are still problems. The eastern interchange closes for maintenance twice a month, and buses do not always wait for a delayed train. But on the platform, the complaints are practical rather than fundamental. The question now is not whether the night line should exist. It is how far it should go.',
                'A decision on extending the route is expected before winter. For the baker and the nurse, that decision cannot come soon enough. They have started saving each other a seat.'
            ],
            quote: 'For once, the city waits for the people who keep it running.'
        },
        {
            id: 'rooftop-forest', cat: 'Climate', art: 'climate', time: '5:48 AM', read: '5 min',
            byline: 'Jon Bell', title: 'A rooftop forest is cooling the old market district, one building at a time',
            standfirst: 'Three summers of sensors show what shopkeepers already suspected: the green roofs are making the street below more bearable.',
            body: [
                'From street level, the change is easy to miss. Look up and the old market district has grown a second, softer skyline: clipped hedges, climbing vines and rows of small trees in deep planters.',
                'The project began as a heat study. Twenty-two roofs were fitted with soil, drainage and drought-tolerant plants, then watched by a network of cheap temperature sensors. The results were modest but stubbornly consistent. On the hottest afternoons, the shaded side of the street ran nearly two degrees cooler than comparable blocks nearby.',
                'Shopkeepers report lower air-conditioning bills and more people lingering outdoors. Residents talk about something harder to measure: the sound of birds in the morning, and the feeling that the building has become part of the street rather than a wall above it.',
                'The scheme is not a substitute for shade at ground level, and the initial cost remains out of reach for many small landlords. The city is now considering a shared fund that would let neighbouring buildings apply together.',
                'For now, the experiment has done what good public projects often do: it has made a better future visible, one rooftop at a time.'
            ],
            quote: 'The street below is two degrees cooler, and the pavement stays busy after five.'
        },
        {
            id: 'warm-coral', cat: 'Science', art: 'science', time: '5:20 AM', read: '6 min',
            byline: 'Dr. Nia Okafor', title: 'A coral that likes warm water gives researchers a cautious reason to hope',
            standfirst: 'A small colony off the southern reef has survived four heat waves. Scientists are careful not to call it a rescue.',
            body: [
                'The colony is not much to look at: a spread of brownish branches no wider than a dining table. But its survival has made it one of the most closely watched pieces of reef in the region.',
                'During the last four marine heat waves, nearby corals bleached and in some cases died. This colony kept its colour. Samples suggest it hosts a different mix of microscopic algae, partners that appear to tolerate warmer water.',
                'The finding is promising, not conclusive. A single resilient colony does not rebuild a reef, and moving corals between sites can introduce disease or weaken local populations. Researchers are testing whether the algae can be shared naturally, without intervention.',
                'What excites the team most is the method: inexpensive sensors, repeated photographs from the same angles, and a network of local divers who know the reef in every season. The data is richer than a single expedition could produce.',
                'The next survey begins at the end of the month. The question is no longer whether some corals can endure a hotter ocean. It is what else they need in order to stay.'
            ],
            quote: 'One surviving colony is a clue, not a cure.'
        },
        {
            id: 'four-am-bakery', cat: 'Culture', art: 'food', time: '4:55 AM', read: '4 min',
            byline: 'Lena Park', title: 'The bakery that opens at four, and the street that slows down around it',
            standfirst: 'Before the buses start, one corner of the old quarter smells of butter and cardamom. The regulars say the queue is part of the recipe.',
            body: [
                'The lights come on at four. By half past, the first tray is out and the first customer is already leaning against the window, still half asleep.',
                'The bakery has no sign, no delivery app and no plan to expand. It opens when the dough is ready and closes when the shelves are empty. Somehow, that has been enough for nineteen years.',
                'What has changed is the street. A bus driver stops for a paper bag before his shift. Nurses arrive in small groups after the night handover. A group of teenagers, improbably awake, debate which pastry deserves the last of their money.',
                'The owner says she has been offered money to franchise the name. She has refused every time. The bakery works, she explains, because she can still taste every batch and recognise every face.',
                'By nine, the shelves are bare. The shutters come down, the street returns to its ordinary pace, and the queue begins again tomorrow at four.'
            ],
            quote: 'The queue is not a delay. It is where the neighbourhood says good morning.'
        },
        {
            id: 'family-final', cat: 'Sport', art: 'sport', time: '6:02 AM', read: '5 min',
            byline: 'Theo Grant', title: 'The final is a family affair: three siblings, two teams, one dinner table',
            standfirst: 'On Sunday, the city final will put two sisters on opposite benches and their brother in the stands, wearing a shirt he refuses to explain.',
            body: [
                'The fixture list made the joke before anyone else could. Northside against Riverside, the two best teams in the city, and two sisters who grew up sharing a bedroom.',
                'The elder sister coaches Northside. The younger plays midfield for Riverside. Their brother, a former referee, has tickets for the family section and a shirt with both club colours stitched down the middle.',
                'At home, the rivalry is carefully managed. Dinner is early, phones go face down, and nobody mentions the league table. Their mother has one rule: whatever happens on Sunday, everyone comes back for soup.',
                'Both teams say the match is bigger than the family story. It is also, unmistakably, the family story. Ticket sales have doubled, and the local radio station is sending a crew to the mother’s kitchen.',
                'The sisters have not spoken about tactics. They have spoken about soup. That, their brother says, is how you know it is serious.'
            ],
            quote: 'Whatever happens on Sunday, everyone comes back for soup.'
        },
        {
            id: 'bench-map', cat: 'City', art: 'map', time: '7:05 AM', read: '3 min',
            byline: 'Iris Chen', title: 'The bench map: 140 places to sit and watch the city go by',
            standfirst: 'A hand-drawn guide started as a joke between friends. Now it is the most useful thing on the neighbourhood noticeboard.',
            body: [
                'It began with a disagreement about the best bench in the city. One friend preferred the view of the river. Another insisted the real answer was the bench outside the library, where the afternoon light lands on the reading room windows.',
                'The argument became a map. Fourteen benches, each with a note about shade, noise and the best hour to arrive. Within a week, strangers had added their own favourites in pencil.',
                'The map now lists 140 places, from a stone ledge behind the station to a folding chair that appears outside a repair shop whenever the owner is not busy. It is printed on paper, updated by hand, and pinned to the noticeboard by the market.',
                'The creators have resisted an app. A map you can hold, they say, invites conversation. Someone always leans over to point out a bench you have missed.',
                'The latest addition is marked in red ink: a bench with a good view of the sunset, a short walk from the last stop on the night line.'
            ],
            quote: 'A map you can hold invites someone to lean over and add a place you missed.'
        },
        {
            id: 'bedroom-records', cat: 'Culture', art: 'culture', time: '6:35 AM', read: '8 min',
            byline: 'Samir Vale', title: 'Six bedroom records that gave the city its new sound',
            standfirst: 'No studio, no budget, no permission. A generation of musicians turned small rooms into the city’s most interesting venue.',
            body: [
                'The sound is hard to describe until you hear it in context: soft keyboards, field recordings from the market, a drum machine that seems to be thinking out loud. It could only have been made in a room with a window open.',
                'Over the past three years, a loose group of musicians has released a series of records recorded at home. The files are exchanged online, but the music belongs to particular streets. You can hear the 6 a.m. tram in one track and a neighbour’s radio in another.',
                'The records have found an audience far beyond the city. Tourists ask about the venues; there are none. Fans ask about the studios; they are bedrooms, kitchens and a converted storage cupboard.',
                'The musicians are wary of the attention. They worry that a scene built on low rents and borrowed equipment will be packaged too quickly. For now, they keep playing small shows and splitting the door money.',
                'A compilation is due next month. It will be pressed in a limited run and sold at the market, next to the bakery. The cover is a photograph of an open window.'
            ],
            quote: 'The room is not a limitation. It is the instrument.'
        },
        {
            id: 'repair-cafe', cat: 'Science', art: 'science', time: '5:36 AM', read: '4 min',
            byline: 'Ruth Adeyemi', title: 'The repair café where a broken radio becomes a lesson in patience',
            standfirst: 'Every Saturday, a church hall fills with faulty lamps, loose handles and people willing to learn how things work.',
            body: [
                'The radio arrived in three pieces and a shoebox. Its owner had been told it was not worth fixing. Forty minutes later, a retired engineer had found a cracked solder joint and a room full of spectators had learned what a multimeter does.',
                'The repair café runs on a simple idea: bring something broken, sit with a volunteer, and try to fix it together. Nothing is done behind a curtain. The point is not only the object but the confidence that comes from opening it.',
                'Some repairs take minutes. Others are declared beyond help, which is its own kind of useful answer. Volunteers log every fault, building a quiet archive of which products fail and how.',
                'The café has become a Saturday institution. Teenagers come to learn to solder; older residents bring stories attached to objects. A lamp with a cracked base turned out to have crossed the country three times.',
                'The radio went home working. Its owner stayed to help with the next one.'
            ],
            quote: 'Nothing is done behind a curtain. The point is to open it.'
        },
        {
            id: 'quiet-delivery', cat: 'Climate', art: 'climate', time: '6:58 AM', read: '5 min',
            byline: 'Jon Bell', title: 'The quiet delivery hour that shops and residents both want to keep',
            standfirst: 'For six months, heavy vans were kept out of the old quarter before eight. The streets are calmer, but the experiment is not free.',
            body: [
                'The first thing residents noticed was not the silence. It was the sleep. With deliveries moved to cargo bikes and a single shared van, the 5 a.m. tailgate slams stopped.',
                'The pilot covered eleven streets for six months. Shops received deliveries through a consolidation centre on the edge of the quarter. Drivers planned routes together instead of competing for the same kerb.',
                'Not every business benefited. Cafés needed fresh produce earlier than the shared vans could provide, and two shops opted out. The scheme’s organizers say those exceptions are part of the design, not a failure.',
                'Measurements showed a modest drop in morning traffic and a larger drop in noise complaints. The most persuasive evidence came from the pavement: more people walking to work, and more children crossing the street without a hand held tight.',
                'The council will vote on making the scheme permanent in spring. Shopkeepers have asked for one change: a later collection window for bakery waste. The quiet hour, they say, should not make the bread wait.'
            ],
            quote: 'The city did not get slower. It got quieter enough to notice itself.'
        },
        {
            id: 'noodle-shop', cat: 'Culture', art: 'food', time: '7:12 AM', read: '6 min',
            byline: 'Lena Park', title: 'After forty years, the noodle shop has a new recipe: none',
            standfirst: 'The menu has not changed since 1986. That, the owner says, is why people keep coming back.',
            body: [
                'There are eight things on the menu and one of them is sold out by noon. The tables are small, the tea is hot, and the handwritten prices have been corrected so many times that the paper looks like a map.',
                'The shop opened forty years ago. Its recipes came from a family kitchen and have survived three renovations, two rent increases and a brief, unsuccessful experiment with a second location.',
                'The current owner took over from her mother without changing the stock or the supplier. Regulars say they can taste the continuity. A bowl ordered after a long absence arrives exactly as remembered.',
                'Younger customers have discovered the place through photographs online. The owner is amused by the attention but wary of the queue. She has refused to add a waiting list. If you want the noodles, you wait like everyone else.',
                'Asked about the future, she points to the kitchen. Her niece is learning the broth. The recipe is not written down. It is taught by standing beside someone, tasting, and trying again.'
            ],
            quote: 'The recipe is not written down. It is taught by standing beside someone.'
        }
    ];
    var NW_CATS = ['Top', 'City', 'Science', 'Culture', 'Sport'];
    var nwCat = 'Top';
    var nwOpenId = '';
    var nwSaved = {};
    var NW_ART = {
        city: { bg: '#EBC9B7', ink: '#3A211A', accent: '#D25734', soft: '#F5E4D9' },
        climate: { bg: '#C8DED5', ink: '#173B33', accent: '#2E7D6E', soft: '#E6F1EC' },
        science: { bg: '#CDD6ED', ink: '#202B55', accent: '#4562C4', soft: '#E8ECF9' },
        culture: { bg: '#E6CBD4', ink: '#3D1D2A', accent: '#A44A6C', soft: '#F5E6EB' },
        sport: { bg: '#CFE0C9', ink: '#193A25', accent: '#2A7A4B', soft: '#E9F1E5' },
        food: { bg: '#EFD4A9', ink: '#3D2812', accent: '#B36B27', soft: '#F9EBD5' },
        map: { bg: '#E8DCC5', ink: '#343026', accent: '#B05235', soft: '#F6EEE0' }
    };

    function nwFind(id) {
        for (var i = 0; i < NW_STORIES.length; i++) if (NW_STORIES[i].id === id) return NW_STORIES[i];
        return null;
    }

    function loadNews() {
        return getEnv().then(function (env) { return { env: env || {} }; },
            function () { return { env: {} }; });
    }

    function nwEdition(env) {
        var day = env && env.day ? String(env.day) : '1016';
        var season = env && env.season ? String(env.season) : 'Autumn';
        return 'NO. ' + day + ' · ' + season.toUpperCase();
    }

    // A small editorial illustration, drawn rather than downloaded: the same artwork language
    // as a printed section front, without depending on a live image service.
    function nwArt(story, variant) {
        var p = NW_ART[story.art] || NW_ART.city;
        var box = node('div', 'nw-art' + (variant ? ' ' + variant : ''));
        box.style.backgroundColor = p.bg;
        var svg = svgEl('svg');
        svg.setAttribute('viewBox', '0 0 320 180');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        svg.setAttribute('class', 'nw-art-svg');
        if (story.art === 'city') {
            glyphShape(svg, 'circle', { cx: '254', cy: '48', r: '31', fill: p.soft, opacity: '0.95' });
            glyphShape(svg, 'rect', { x: '24', y: '91', width: '34', height: '89', fill: p.ink, opacity: '0.9' });
            glyphShape(svg, 'rect', { x: '65', y: '66', width: '27', height: '114', fill: p.accent });
            glyphShape(svg, 'rect', { x: '99', y: '103', width: '44', height: '77', fill: p.ink, opacity: '0.75' });
            glyphShape(svg, 'rect', { x: '151', y: '78', width: '38', height: '102', fill: p.soft });
            glyphShape(svg, 'rect', { x: '197', y: '112', width: '29', height: '68', fill: p.ink, opacity: '0.58' });
            glyphShape(svg, 'rect', { x: '234', y: '87', width: '59', height: '93', fill: p.accent, opacity: '0.86' });
            glyphShape(svg, 'rect', { x: '0', y: '150', width: '320', height: '2', fill: p.ink, opacity: '0.42' });
        } else if (story.art === 'climate') {
            glyphShape(svg, 'circle', { cx: '238', cy: '47', r: '25', fill: p.soft });
            glyphShape(svg, 'path', { d: 'M-20 94C35 66 70 116 124 90S211 62 340 98V134C267 108 215 140 151 119S42 112-20 140Z', fill: p.accent, opacity: '0.85' });
            glyphShape(svg, 'path', { d: 'M-20 123C45 98 83 145 140 119S231 99 340 132V180H-20Z', fill: p.ink, opacity: '0.78' });
            glyphShape(svg, 'path', { d: 'M23 52c25-18 55-18 80 0M52 76c15-10 32-10 47 0', fill: 'none', stroke: p.ink, 'stroke-width': '2', opacity: '0.42' });
        } else if (story.art === 'science') {
            glyphShape(svg, 'ellipse', { cx: '160', cy: '90', rx: '116', ry: '44', fill: 'none', stroke: p.accent, 'stroke-width': '2', opacity: '0.8', transform: 'rotate(-17 160 90)' });
            glyphShape(svg, 'ellipse', { cx: '160', cy: '90', rx: '78', ry: '78', fill: 'none', stroke: p.ink, 'stroke-width': '1.5', opacity: '0.36' });
            glyphShape(svg, 'circle', { cx: '160', cy: '90', r: '27', fill: p.accent });
            glyphShape(svg, 'circle', { cx: '250', cy: '57', r: '8', fill: p.ink });
            glyphShape(svg, 'circle', { cx: '70', cy: '124', r: '5', fill: p.soft });
            glyphShape(svg, 'circle', { cx: '219', cy: '137', r: '4', fill: p.ink, opacity: '0.55' });
        } else if (story.art === 'culture') {
            glyphShape(svg, 'rect', { x: '31', y: '35', width: '119', height: '146', fill: p.ink, opacity: '0.92' });
            glyphShape(svg, 'circle', { cx: '174', cy: '91', r: '68', fill: p.soft });
            glyphShape(svg, 'circle', { cx: '174', cy: '91', r: '34', fill: p.accent });
            glyphShape(svg, 'rect', { x: '227', y: '54', width: '66', height: '108', fill: p.accent, opacity: '0.62' });
            glyphShape(svg, 'path', { d: 'M54 146C78 104 112 88 132 61', fill: 'none', stroke: p.soft, 'stroke-width': '2.5', opacity: '0.72' });
        } else if (story.art === 'sport') {
            glyphShape(svg, 'path', { d: 'M-20 156C53 113 107 184 172 143S261 97 340 128', fill: 'none', stroke: p.accent, 'stroke-width': '14', opacity: '0.86' });
            glyphShape(svg, 'path', { d: 'M-20 134C55 96 112 160 180 119S268 77 340 104', fill: 'none', stroke: p.ink, 'stroke-width': '2', opacity: '0.44' });
            glyphShape(svg, 'circle', { cx: '249', cy: '52', r: '23', fill: p.soft });
            glyphShape(svg, 'path', { d: 'M238 45h22M234 55h30M243 34l4 34', fill: 'none', stroke: p.ink, 'stroke-width': '1.4', opacity: '0.5' });
        } else if (story.art === 'food') {
            glyphShape(svg, 'circle', { cx: '160', cy: '93', r: '66', fill: p.soft });
            glyphShape(svg, 'circle', { cx: '160', cy: '93', r: '47', fill: 'none', stroke: p.accent, 'stroke-width': '8', opacity: '0.8' });
            glyphShape(svg, 'circle', { cx: '160', cy: '93', r: '26', fill: p.accent, opacity: '0.42' });
            glyphShape(svg, 'path', { d: 'M36 38v105M46 38v105M36 38v35c0 7 10 7 10 0V38M266 38c-14 7-17 32-8 43v62', fill: 'none', stroke: p.ink, 'stroke-width': '3.2', 'stroke-linecap': 'round', opacity: '0.82' });
        } else {
            glyphShape(svg, 'path', { d: 'M19 139C62 100 77 46 140 62s55 68 118 37c23-11 36-6 45 4', fill: 'none', stroke: p.accent, 'stroke-width': '3' });
            glyphShape(svg, 'path', { d: 'M20 40l48 27-14 39 84 12 41-48 66 26', fill: 'none', stroke: p.ink, 'stroke-width': '1.3', opacity: '0.28' });
            glyphShape(svg, 'circle', { cx: '19', cy: '139', r: '7', fill: p.accent });
            glyphShape(svg, 'circle', { cx: '258', cy: '99', r: '7', fill: p.ink });
            glyphShape(svg, 'circle', { cx: '138', cy: '118', r: '4', fill: p.accent, opacity: '0.6' });
        }
        box.appendChild(svg);
        box.appendChild(node('div', 'nw-art-tag', story.cat.toUpperCase()));
        return box;
    }

    function nwSaveButton(story, compact) {
        var saved = !!nwSaved[story.id];
        var b = node('button', 'nw-save' + (saved ? ' on' : '') + (compact ? ' compact' : ''), saved ? 'Saved' : 'Save');
        b.setAttribute('type', 'button');
        onTap(b, function (e) {
            e.stopPropagation();
            nwSaved[story.id] = !nwSaved[story.id];
            b.className = 'nw-save' + (nwSaved[story.id] ? ' on' : '') + (compact ? ' compact' : '');
            b.textContent = nwSaved[story.id] ? 'Saved' : 'Save';
        });
        return b;
    }

    function nwStoryOpen(story) {
        nwOpenId = story.id;
        open('newsdetail');
    }

    function nwMeta(story) {
        var m = node('div', 'nw-meta');
        m.appendChild(node('span', 'nw-meta-dot'));
        m.appendChild(node('span', null, story.time + ' · ' + story.read + ' read'));
        return m;
    }

    function nwHero(story) {
        var c = node('div', 'nw-hero');
        onTap(c, function (e) { e.stopPropagation(); nwStoryOpen(story); });
        c.appendChild(nwArt(story, 'nw-hero-art'));
        var body = c.appendChild(node('div', 'nw-hero-body'));
        var top = body.appendChild(node('div', 'nw-kicker-row'));
        top.appendChild(node('div', 'nw-kicker', story.cat.toUpperCase()));
        top.appendChild(node('div', 'nw-kicker-note', 'LEAD STORY'));
        body.appendChild(node('div', 'nw-hero-title', story.title));
        body.appendChild(node('div', 'nw-hero-deck', story.standfirst));
        var foot = body.appendChild(node('div', 'nw-hero-foot'));
        foot.appendChild(nwMeta(story));
        foot.appendChild(node('div', 'nw-byline', 'By ' + story.byline));
        return c;
    }

    function nwRow(story, number) {
        var row = node('div', 'nw-row');
        onTap(row, function (e) { e.stopPropagation(); nwStoryOpen(story); });
        if (number) row.appendChild(node('div', 'nw-rank', number));
        row.appendChild(nwArt(story, 'nw-row-art'));
        var body = row.appendChild(node('div', 'nw-row-body'));
        body.appendChild(node('div', 'nw-row-kicker', story.cat.toUpperCase()));
        body.appendChild(node('div', 'nw-row-title', story.title));
        body.appendChild(nwMeta(story));
        return row;
    }

    function nwChips() {
        var row = node('div', 'nw-chips');
        NW_CATS.forEach(function (cat) {
            var b = node('button', 'nw-chip' + (cat === nwCat ? ' on' : ''), cat);
            b.setAttribute('type', 'button');
            onTap(b, function (e) {
                e.stopPropagation();
                if (nwCat === cat) return;
                nwCat = cat;
                refresh();
            });
            row.appendChild(b);
        });
        return row;
    }

    function nwSectionHead(title, note) {
        var h = node('div', 'nw-section-head');
        h.appendChild(node('div', 'nw-section-title', title));
        if (note) h.appendChild(node('div', 'nw-section-note', note));
        return h;
    }

    function renderNews(data) {
        var wrap = node('div', 'nw-screen');
        wrap.appendChild(subHeader('news'));
        var env = data && data.env || {};
        var mast = node('div', 'nw-masthead');
        var line = mast.appendChild(node('div', 'nw-mast-line'));
        line.appendChild(node('div', 'nw-mast-name', 'THE CITY DESK'));
        line.appendChild(node('div', 'nw-mast-edition', 'MORNING'));
        mast.appendChild(node('div', 'nw-mast-rule'));
        var sub = mast.appendChild(node('div', 'nw-mast-sub'));
        sub.appendChild(node('div', 'nw-mast-date', nwEdition(env)));
        sub.appendChild(node('div', 'nw-mast-preview', 'PREVIEW FEED'));
        wrap.appendChild(mast);
        wrap.appendChild(nwChips());
        var list = NW_STORIES.filter(function (s) { return nwCat === 'Top' || s.cat === nwCat; });
        if (!list.length) {
            var empty = card();
            empty.appendChild(node('div', 'ph-empty', 'Nothing filed in this section yet.'));
            wrap.appendChild(empty);
            return wrap;
        }
        wrap.appendChild(nwHero(list[0]));
        var rest = list.slice(1);
        if (rest.length) {
            wrap.appendChild(nwSectionHead('Latest', rest.length === 1 ? '1 STORY' : rest.length + ' STORIES'));
            var feed = node('div', 'nw-feed');
            rest.forEach(function (s) { feed.appendChild(nwRow(s)); });
            wrap.appendChild(feed);
        }
        if (nwCat === 'Top') {
            wrap.appendChild(nwSectionHead('Most read this morning', 'THE DESK'));
            var most = node('div', 'nw-most');
            list.slice(1, 5).forEach(function (s, i) {
                var row = node('div', 'nw-most-row');
                onTap(row, function (e) { e.stopPropagation(); nwStoryOpen(s); });
                row.appendChild(node('div', 'nw-most-num', String(i + 1).length < 2 ? '0' + (i + 1) : String(i + 1)));
                row.appendChild(node('div', 'nw-most-title', s.title));
                row.appendChild(node('div', 'nw-most-time', s.read));
                most.appendChild(row);
            });
            wrap.appendChild(most);
        }
        var foot = node('div', 'nw-editor-note');
        foot.appendChild(node('div', 'nw-editor-mark'));
        var ft = foot.appendChild(node('div', 'nw-editor-text'));
        ft.appendChild(node('div', 'nw-editor-title', 'A preview edition'));
        ft.appendChild(node('div', 'nw-editor-body', 'These stories and illustrations are local demo content. No live news source is connected yet.'));
        wrap.appendChild(foot);
        return wrap;
    }

    function nwParagraphs(story, wrap) {
        story.body.forEach(function (text) {
            wrap.appendChild(node('p', 'nw-body-p', text));
        });
    }

    function nwRelated(story, wrap) {
        var related = NW_STORIES.filter(function (s) { return s.id !== story.id && s.cat === story.cat; }).slice(0, 2);
        if (!related.length) {
            related = NW_STORIES.filter(function (s) { return s.id !== story.id; }).slice(0, 2);
        }
        wrap.appendChild(nwSectionHead('More from ' + story.cat, 'THE DESK'));
        var list = node('div', 'nw-related');
        related.forEach(function (s) { list.appendChild(nwRow(s)); });
        wrap.appendChild(list);
    }

    function renderNewsDetail() {
        var story = nwFind(nwOpenId);
        var wrap = node('div', 'nw-screen nw-detail');
        wrap.appendChild(subHeader('newsdetail', 'Story'));
        if (!story) {
            var gone = card();
            gone.appendChild(node('div', 'ph-empty', 'This story is no longer on the front page.'));
            wrap.appendChild(gone);
            return wrap;
        }
        var head = node('div', 'nw-detail-head');
        var top = head.appendChild(node('div', 'nw-detail-top'));
        top.appendChild(node('div', 'nw-detail-kicker', story.cat.toUpperCase()));
        top.appendChild(nwSaveButton(story, true));
        head.appendChild(node('h1', 'nw-detail-title', story.title));
        head.appendChild(node('div', 'nw-detail-deck', story.standfirst));
        var by = head.appendChild(node('div', 'nw-detail-by'));
        by.appendChild(node('div', 'nw-detail-author', 'By ' + story.byline));
        by.appendChild(node('div', 'nw-detail-time', story.time + ' · ' + story.read + ' read'));
        wrap.appendChild(head);
        wrap.appendChild(nwArt(story, 'nw-detail-art'));
        wrap.appendChild(node('div', 'nw-art-caption', 'Illustration for The City Desk · ' + story.cat));
        var body = node('div', 'nw-detail-body');
        nwParagraphs(story, body);
        if (story.quote) {
            var q = body.appendChild(node('blockquote', 'nw-quote'));
            q.appendChild(node('div', 'nw-quote-mark', '“'));
            q.appendChild(node('div', 'nw-quote-text', story.quote));
        }
        body.appendChild(node('div', 'nw-detail-end'));
        wrap.appendChild(body);
        var tags = node('div', 'nw-tags');
        tags.appendChild(node('span', 'nw-tag', story.cat));
        tags.appendChild(node('span', 'nw-tag', 'Morning edition'));
        tags.appendChild(node('span', 'nw-tag', 'Local'));
        wrap.appendChild(tags);
        var note = node('div', 'nw-detail-note');
        note.appendChild(node('div', 'nw-detail-note-title', 'About this preview'));
        note.appendChild(node('div', 'nw-detail-note-body', 'This is a demonstration article bundled with the app. It is not a report from a live source, and no external feed has been fetched.'));
        wrap.appendChild(note);
        nwRelated(story, wrap);
        return wrap;
    }

