# Sounds

Files are named `<event>_<n>.mp3` (`kill_1.mp3`, `double_kill_2.mp3`, …) and listed in `sounds.config.json`.

Events without a file of their own fall back to the `kill` sound (multikills and streaks) or stay silent (`death`).
`npm run gen:sounds` creates short placeholder tones for any configured file that is missing.

## Adding your own sounds

1. Put audio files here. Any format ffmpeg reads works: mp3, ogg, wav, m4a, flac, and others.
2. List them in `sounds.config.json` under `events`. When an event has several files, one is picked at random, and the same file won't play twice in a row:

   ```json
   "kill": ["kill.wav", "headshot.mp3", "my-voice/nice.ogg"]
   ```

3. Restart the app. Missing files are reported as warnings at startup.

## Event keys

| Key | When |
|---|---|
| `kill` | a single kill |
| `double_kill`, `triple_kill`, `ultra_kill`, `rampage` | 2/3/4/5+ kills chained within `MULTIKILL_WINDOW_MS` of game time. A jump of N kills in one update counts as N kills. |
| keys from `streaks` | `kill_streak` reaches that number (default: `killing_spree` at 3 … `beyond_godlike` at 10) |
| `death` | you died. Plays only with `ANNOUNCE_DEATHS=true`. |
| `victory` | your team won the match (once, when Dota shows the result) |
| `defeat` | your team lost the match |

Only one sound plays per update, by priority: multikill, then streak, then kill.
`victory` and `defeat` play in every announcer mode and never fall back to the `kill` sound: without a file they stay silent.

```json
"victory": ["victory_1.mp3"],
"defeat": ["defeat_1.mp3"]
```

## Volume

- `volume` at the top of the config is the **master volume** for every sound: 0 to 2, where 1 is the original loudness.
- Any file can have its own volume. Write it as an object instead of a plain name:

  ```json
  "kill": [
    "kill.mp3",
    { "file": "loud_clip.mp3", "volume": 0.5 },
    { "file": "quiet_clip.ogg", "volume": 1.8 }
  ]
  ```

  The final volume is master × file. With `"volume": 0.8` above, `loud_clip.mp3` plays at 0.4 and `quiet_clip.ogg` at 1.44. A plain name means file volume 1.
- Volume changes take effect after restarting the app.

## Other settings

- `soundsDir`: folder with the files, relative to the config file.

Use short clips, roughly 0.5–2 s. The queue keeps at most 2 waiting sounds and drops older ones.

To regenerate the placeholders over your own files, run `npm run gen:sounds -- --force`. This **overwrites** them.
