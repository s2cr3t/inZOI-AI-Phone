# Phone app source

`mods/HouseholdBoard_I6IXIO/ui/phone/app.js` is built from these pieces, joined in file-name order:

```
node tools/build-phone.js            # write app.js
node tools/build-phone.js --deploy   # write it and copy it into the installed mod
node tools/build-phone.js --check    # fail when app.js is out of date (the tests run this)
```

The pieces are the parts of the one function that is the phone (`01-core.js` opens it,
`24-banner.js` closes it), so every piece sees every other piece's variables, as before. Their
order matters: a piece may use what an earlier one declares at load time. A piece on its own is
not valid JavaScript, so an editor may mark the first and last lines; check the built `app.js`.

The game, `index.html`, the installer and the CurseForge package keep using `app.js` as before.
Keep the pieces in CRLF and ES5 (`var`, no arrow functions or template strings): the game's UI
engine runs the file as it is.

| Piece | What it holds |
|---|---|
| 01-core | requests to the game, time, game data, work schedule, DOM helpers |
| 02-sounds | sounds |
| 03-home | home screen, pages, dock, swipe home |
| 04-family | Family, Bonds, Stories, 纪念与信任 |
| 05-contacts | Contacts |
| 06-oa | OA |
| 07-jobs | Jobs |
| 08-freelance | Freelance |
| 09-texts | Texts |
| 10-groups | group chats and group settings |
| 11-persona | persona editing |
| 12-moments | Moments |
| 13-transitions | screen transitions |
| 14-ai-service | AI settings and setup guide |
| 15-settings | Settings, Sounds, Wallpaper |
| 16-messages | the game's own Messages |
| 17-navigation | navigation, refresh, app registry |
| 18-app-store | App Store |
| 19-dream-car | Dream Car |
| 20-news | News |
| 21-booklet | 成长册 |
| 21-school | 成绩 |
| 22-apps | the apps of this phone |
| 23-redraw | redrawing in place |
| 23-voice | voice input in the texts (lib/voice.js) |
| 24-banner | incoming text banner, the poll |
