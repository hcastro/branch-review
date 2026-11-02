# widget

A tiny terminal dashboard for watching your build queue, with a live preview of each job's output.

> [!TIP]
> Run `widget preview <job>` to open a job's output in a side panel.

![The widget dashboard showing three running jobs](img/hero.png)

## Install

```sh
npm install -g widget
```

## Commands

| Command | What it does |
| --- | --- |
| `watch` | Follow the queue and refresh every 2 seconds |
| `logs` | Stream the logs of the selected job |
| `preview` | Render a job's output in a side panel |

## Configuration

widget reads `~/.config/widget/config.toml` on startup. Every key is optional.

## Roadmap

- [x] Queue view
- [x] Log streaming
- [x] Preview panel
- [ ] Remote runners

## Use it from code

```ts
import { createPreview } from "widget";

const preview = createPreview({ job: "build-142", follow: true });
preview.on("line", (line) => console.log(line));
```

## License

MIT

[Guide](docs/guide.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)
