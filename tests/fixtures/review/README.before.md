# widget

A tiny terminal dashboard for watching your build queue.

## Install

```sh
npm install -g widget
```

## Commands

| Command | What it does |
| --- | --- |
| `watch` | Follow the queue and refresh every 2 seconds |
| `logs` | Stream the logs of the selected job |

Press `o` to open the config in your editor.

## Configuration

widget reads `~/.config/widget/config.toml` on startup. Every key is optional.

## License

MIT
