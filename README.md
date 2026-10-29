# ThKoelnGaussianViewer

A local browser viewer for Gaussian splat scenes (`.ply`, `.spz`, `.splat`, `.ksplat`). It is the viewer part of ImageToGaussian without the generation pipeline.

## Requirements

- Node.js 22 or newer (https://nodejs.org)
- A browser with WebGL 2 (Chrome, Edge, Firefox or Safari)

## Installation

Windows: double-click `install.cmd`.

macOS and Linux: open a terminal in this folder and run

```sh
./install.sh
```

This installs the dependencies and builds the viewer. On Linux it also adds "Gaussian Viewer" to the application menu.

## Starting

Windows: double-click `Start Viewer.cmd`.

macOS: double-click `Start Viewer.command`. If macOS refuses to open it because it was downloaded from the internet, right-click it, choose Open and confirm once.

Linux: open "Gaussian Viewer" from the application menu, or run `./start.sh`.

The viewer opens in your browser at http://127.0.0.1:43210. Closing the terminal window stops it. If it has not been installed yet, the start script runs the installation first.

## Scenes

Put your splat files into the `scenes` folder. Subfolders show up as groups in the scene list. Use "Reload" in the scene list after adding files.

Files next to a scene with the same name are picked up as well:

- `Room.jpg` (or `.png`, `.webp`): thumbnail and the original image for the compare slider
- `Room.json`: view mode, for example `{"mode": "panorama"}`

Modes are `image` (orbit around the scene, the default), `hemisphere` (180° panorama) and `panorama` (360°). The mode can also be switched in the viewer.

You can also drop a splat file onto the page or open one with the folder button at the top right. These files are not copied anywhere.

To use another folder or port:

```sh
node server.js --open --scenes /path/to/scenes --port 8080
```

## Controls

Photo mode: drag to orbit, right-drag to pan, scroll to zoom.

Panorama modes: drag to tilt the view, arrow keys to turn (Shift turns faster), W/A/S/D to move, Q/E to move down and up.

Left and right arrow keys switch between scenes. VR headsets are supported in browsers with WebXR; on the controllers A/B switch scenes and X/Y reset the position.

## Development

```sh
npm run dev
```

starts Vite with hot reload. It expects `node server.js` to be running on port 43210.

## License

MIT, see [LICENSE](LICENSE).
