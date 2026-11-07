    // ------------------------------------------------------------------
    // The apps of this phone
    // ------------------------------------------------------------------
    screens.home = { load: loadHome, render: renderHome };
    registerApp({ id: 'family', label: 'Family', cls: 'ic-family', category: 'Household', version: '1.4',
        desc: 'Your household at a glance', subtitle: 'Your household at a glance',
        featured: 'Know how everyone at home is doing',
        about: 'Everyone who lives with you on one page: their mood, how hungry, tired or lonely they are, and where they are right now.',
        screens: { family: { load: loadFamily, render: renderFamily } } });
    registerApp({ id: 'bonds', label: 'Bonds', cls: 'ic-bonds', category: 'Household', version: '1.2',
        desc: 'Friendship, romance and family ties', subtitle: 'Friendship, romance and family ties',
        about: 'How close the character you play is to each person they know, as friendship, romance, family and business.',
        screens: { bonds: { load: loadBonds, render: renderBonds } } });
    registerApp({ id: 'oa', label: 'OA', cls: 'ic-oa', category: 'Career', version: '2.0',
        desc: '职级、考勤、假期，和上级说事', subtitle: '职级、考勤、假期，和上级说事',
        featured: '工作上的事，找上级谈',
        whatsNew: 'Work 改名为 OA，换成公司工作台的样子：考勤打卡、数据看板和绩效评级、公司通知、组织架构、薪酬职级。请假、病假、远程办公、晋升和离职走审批单，提交后发给上级，申请记录可以随时查看和撤回。',
        about: '每个家人的工作台：公司、职级和离下一级还差多少经验，今天的上班时间，绩效、出勤、年假和旷工记录，上级和同事是谁。要请假、请病假、远程办公、谈晋升或者辞职，在这里写好申请，发给上级，在聊天里谈。',
        screens: {
            oa: { load: loadOa, render: renderOa, title: 'OA' },
            oaApply: { load: loadOa, render: renderOaApply, title: '发起申请', parent: 'oa' },
            oaOrg: { load: loadOa, render: renderOaOrg, title: '组织架构', parent: 'oa' },
            oaPay: { load: loadOa, render: renderOaPay, title: '薪酬职级', parent: 'oa' }
        } });
    registerApp({ id: 'school', label: '成绩', cls: 'ic-school', glyph: schoolGlyph, category: 'Education', version: '1.0',
        desc: '成绩单、课表和老师评语', subtitle: '成绩单、课表和老师评语',
        featured: '孩子在学校怎么样，一看就知道',
        about: '像学校的家校通一样：小学生看自己的 A、B、C 等级和离下一级还差多少，初中生和高中生看每周的成绩单、考试分数、出勤和作业，还有一周的课表和班主任的评语。成绩、考试、出勤和作业都来自游戏里的学校记录。',
        screens: { school: { load: loadSchool, render: renderSchool, title: '成绩' } } });
    registerApp({ id: 'time', label: 'Time', cls: 'ic-time', category: 'Utilities', version: '1.1',
        desc: 'Pause, speed up, skip ahead', subtitle: 'Pause, speed up, skip ahead',
        about: 'The game clock in your hand: pause the city, run it at 1x, 2x or 3x, or skip an hour ahead.',
        screens: { time: { load: loadTime, render: renderTime } } });
    registerApp({ id: 'jobs', label: 'Jobs', cls: 'ic-jobs', category: 'Career', version: '1.5',
        desc: 'Openings in town, one tap to apply', subtitle: 'Openings in town, one tap to apply',
        featured: 'Find a job that fits',
        about: 'Every job opening in town with its hours, workdays and pay. Pick a household member and apply on the spot.',
        screens: { jobs: { load: loadJobs, render: renderJobs } } });
    registerApp({ id: 'freelance', label: 'Freelance', cls: 'ic-freelance', category: 'Career', version: '1.2',
        desc: 'Take orders, earn on your own time', subtitle: 'Take orders, earn on your own time',
        featured: 'Be your own boss',
        whatsNew: 'Orders open straight from the list; Back always stays at the top.',
        about: 'Freelance orders from people in town: deliveries and creative work. Accept an order, follow the one in progress, and see your licenses and record.',
        screens: { freelance: { load: loadFreelance, render: renderFreelance } } });
    registerApp({ id: 'news', label: 'News', cls: 'ic-news', category: 'Media', version: '0.9',
        preinstalled: false,
        desc: 'A morning edition for the city', subtitle: 'A morning edition for the city',
        featured: 'The city, before it wakes',
        whatsNew: 'First preview: a local morning edition, section filters, saved stories and full article pages. The live source feed is not connected yet.',
        about: 'A calm, readable newspaper for the city: a lead story, local sections, a most-read list and full article pages. This preview uses bundled demo stories and drawings; an open-source news feed can be connected later without changing the reading experience.',
        screens: {
            news: { load: loadNews, render: renderNews },
            newsdetail: { load: loadNews, render: renderNewsDetail, title: 'Story', parent: 'news' }
        } });
    registerApp({ id: 'texts', label: 'Texts', cls: 'ic-texts', category: 'Social', dock: true, system: true, version: '2.5',
        desc: 'Chat with your family', subtitle: 'Chat with your family',
        featured: 'Your family, one text away',
        whatsNew: 'A message that gives away what is on someone’s mind is marked, and the end of their story shows in the chat. Both open the new Stories app.',
        about: 'Text the people you live with. They answer in their own voice, remember what you talked about, and can do what you ask in the game.',
        badge: function (data) { return data.unread || 0; },
        screens: {
            texts: { load: loadTexts, render: renderTexts },
            chat: { load: loadChat, render: renderChat, title: 'Chat', parent: 'texts' },
            group: { load: loadGroup, render: renderGroup, title: 'Group', parent: 'texts' },
            groupNew: { load: loadGroupNew, render: renderGroupNew, title: 'New Group', parent: 'texts' },
            textsFolders: { load: loadTexts, render: renderTxFolders, title: '聊天分组', parent: 'texts' },
            groupMembers: { load: loadGroupMembers, render: renderGroupMembers, title: 'Members', parent: 'group' },
            groupName: { load: loadGroupName, render: renderGroupName, title: 'Group Name', parent: 'group' },
            persona: { load: loadPersona, render: renderPersona, title: 'Persona', parent: 'chat' }
        } });
    registerApp({ id: 'stories', label: 'Stories', cls: 'ic-stories', category: 'Social', version: '1.2',
        desc: 'What is on your family’s mind', subtitle: 'What is on your family’s mind',
        featured: 'Everyone has something going on',
        whatsNew: 'Helping pays off: a keepsake from each story you helped with, a thank-you text, a good mood for you both and a Moments post. Trust grows with each one and opens deeper stories. A story that went badly can still be made right for a couple of days. Keepsakes and trust now have a page of their own.',
        about: 'Each person you text has a story of their own: a goal, a secret, some trouble or a surprise. Clues show up here as they let them slip in the chat; their title shows once they tell you. Help them through it and they trust you more, and tell you deeper stories later. Ended stories are kept with what really happened, what you did and what it left behind.',
        badge: function (data) { return data.storiesNew || 0; },
        screens: {
            stories: { load: loadStories, render: renderStories },
            stkeep: { load: loadStoryKeep, render: renderStoryKeep, title: '纪念与信任', parent: 'stories' }
        } });
    registerApp({ id: 'contacts', label: 'Contacts', cls: 'ic-contacts', glyph: contactsGlyph, category: 'Social', version: '1.0',
        desc: 'Everyone in your phone', subtitle: 'Everyone in your phone',
        whatsNew: 'First release: the contacts of your phone in the game, with their faces, jobs and how close you are.',
        about: 'The contact list of your phone in the game: family, friends and everyone else you have met, closest first. Open someone for their job, where they are right now and how you feel about each other, and text the people you live with.',
        screens: {
            contacts: { load: loadContacts, render: renderContacts },
            contact: { load: loadContacts, render: renderContact, title: 'Contact', parent: 'contacts' }
        } });
    registerApp({ id: 'messages', label: 'Messages', cls: 'ic-messages', category: 'Social', version: '1.1',
        desc: 'Banks, services and everyone else', subtitle: 'Banks, services and everyone else',
        whatsNew: 'New messages pop up as banners.',
        about: "The city's own phone messages: people you know, banks, schools and shops. Read them and answer the ones that wait for you.",
        screens: { messages: { load: loadMessages, render: renderMessages } } });
    registerApp({ id: 'moments', label: 'Moments', cls: 'ic-moments', category: 'Social', dock: true, version: '2.0',
        desc: 'What your friends are up to', subtitle: 'What your friends are up to',
        featured: 'Share the moment',
        whatsNew: 'A fresh look, emoji, and times in the city.',
        about: 'Posts from the people you know, with likes and comments. Post your own and see who reacts.',
        badge: function (data) { return data.momentsUnread || 0; },
        screens: { moments: { load: loadMoments, render: renderMoments } } });
    registerApp({ id: 'dreamcar', label: 'Dream Car', cls: 'ic-dreamcar', glyph: dreamCarGlyph, category: 'Household', version: '1.0',
        preinstalled: false,
        desc: 'The city’s car dealer in your pocket', subtitle: 'The city’s car dealer in your pocket',
        featured: 'Drive home your dream car',
        whatsNew: 'First release: every vehicle the game sells, with real photos from the dealer and all its colours.',
        about: 'The game’s own car dealer, 梦中情车, as a phone app: bicycles, scooters, motorbikes and cars with their prices, colours and descriptions. Pick a colour and buy; the game’s dealer handles the payment and delivers the vehicle home. The Garage shows what everyone in the family drives.',
        screens: {
            dreamcar: { load: loadDreamCar, render: renderDreamCar },
            dccar: { load: loadDreamCar, render: renderDreamCarCar, title: 'Vehicle', parent: 'dreamcar' },
            dcgarage: { load: loadDreamCar, render: renderDreamCarGarage, title: 'Garage' }
        } });
    registerApp({ id: 'ai', label: 'AI', cls: 'ic-ai', category: 'Utilities', dock: true, version: '2.51',
        badge: function (data) { return data.aiSetup ? 1 : 0; },
        whatsNew: 'Shows how to get AI Phone Service when this PC does not have it yet, with the download link a tap away.',
        desc: 'The service behind your family', subtitle: 'The service behind your family',
        about: 'Switch the AI phone service on or off, choose a provider and model, and test the connection.',
        screens: { ai: { load: loadAi, render: renderAi } } });
    registerApp({ id: 'settings', label: 'Settings', cls: 'ic-settings', category: 'Utilities', dock: true, system: true, version: '1.0',
        desc: 'Sounds and wallpaper', subtitle: 'Sounds and wallpaper',
        about: 'Phone sounds and the wallpaper, including your own pictures.',
        screens: {
            settings: { load: loadSettings, render: renderSettings },
            sounds: { load: loadSettings, render: renderSounds, title: 'Sounds', parent: 'settings' },
            wallpaper: { load: loadWallpaper, render: renderWallpaper, title: 'Wallpaper', parent: 'settings' }
        } });
    registerApp({ id: 'store', label: 'App Store', cls: 'ic-store', category: 'Utilities', system: true, version: '1.0',
        glyph: storeGlyph, desc: 'Get, open and remove apps', subtitle: 'Get, open and remove apps',
        about: 'Every app this phone can hold. Get the ones you want, remove the ones you do not; their data stays.',
        screens: {
            store: { load: loadStore, render: renderStore },
            storeapp: { load: loadStore, render: renderStoreApp, title: 'App', parent: 'store' }
        } });

