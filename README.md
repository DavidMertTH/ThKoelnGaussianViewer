# ThKoelnGaussianViewer

You need [Node.js](https://nodejs.org) 22 or newer.

## Clone

```sh
git clone https://github.com/DavidMertTH/ThKoelnGaussianViewer.git
cd ThKoelnGaussianViewer
```

## Install

- Windows: double-click `install.cmd`
- macOS / Linux: `./install.sh`

## Start

- Windows: double-click `Start Viewer.cmd`
- macOS: double-click `Start Viewer.command`
- Linux: `./start.sh`

The viewer opens in your browser at http://127.0.0.1:43210.

## Update

Get the new version with `git pull`, then start the viewer as usual. The start scripts notice the new code and install and build it again before the viewer opens, which takes a minute once.

## Scenes

The start page loads without the 3D viewer, so it opens quickly on headsets. "Browse scenes" shows every scene with a thumbnail; pick one to open it in the viewer.

Sort the scenes by name, size or when they were added with the sort menu. Both the scene browser and the browser in VR use and remember the choice.

Click "Folder" and choose the folder with your splat files (`.ply`, `.spz`, `.splat`, `.ksplat`). The viewer remembers it for the next start.

The viewer saves a thumbnail the first time it shows a scene. To create the missing ones in one go, click "Create … thumbnails" in the scene browser on this computer and keep the tab open until it is done. Thumbnails are stored in the `thumbnails` folder.

On Linux the folder dialog needs `zenity` or `kdialog` (installed on most desktops).

## Ratings

Several people can rate the scenes, each on their own computer. "Rate" in the viewer opens the rating panel on the right:

- **Score:** 0 to 5 stars. Click them or press 0 to 5; the same score again clears it.
- **Comment:** saved while typing.
- **Distance:** every scene opens at ×1.00. The value the distance slider has when the next scene opens is saved with the scene, if it was changed while the scene was in view. Coming back to a scene starts at ×1.00 again and keeps the saved value unless the slider is moved.

Ratings are saved in the `ratings` folder next to the viewer. "Export" saves this computer's ratings as a file. On the computer that collects them, "Import" adds such a file and asks for the name of the person who rated; importing again under the same name replaces their earlier ratings. Imported ratings show under "All ratings" for the scene in view, with the average score and distance; click a distance to see the scene at it. Importing only works on the computer running the viewer, not from headsets or other devices.

## Debugging

Start the viewer with `--debug` to show frame-rate displays, in the toolbar and in VR: `./start.sh --debug`, `./start.sh --lan --debug` for headsets, or on Windows `"Start Viewer.cmd" --debug` from a command prompt. They show frames per second, frame times, the renderer in use, how many splats it draws, and for the compute renderer its GPU and CPU times.

## Renderers

The viewer has two ways to draw splats. The button next to "Distance" switches between them, and the viewer remembers the choice.

- **Compute** (the default): WebGPU compute shaders cull, project and sort the splats on the GPU, and the GPU's blending hardware draws them. Scenes load faster because no detail levels are built. It needs WebGPU in the browser; without it the viewer uses WebGL and says so.
- **WebGL**: Spark draws the splats and, in VR, reduces detail with its level-of-detail tree.

The **ambilight** lights the empty background around the scene with the scene's own colours, carried outwards and blurred, like a TV that lights the wall behind it. It is always on and works with both renderers. In VR on WebGPU the open view around the scene glows the same way.

The compute renderer draws the base colour of each splat; view-dependent colour (spherical harmonics) is only drawn by the WebGL renderer. You can also choose with `?renderer=compute` or `?renderer=webgl` in the address. In VR the frame-rate display names the renderer in use.

## 3D glasses and head tracking

**3D** shows the scene in red and cyan for classic paper 3D glasses, red over the left eye. The orbit target sits on the screen; nearer parts come out of it, farther parts lie behind. The ambilight is off meanwhile.

**Head** follows your head with the webcam, so the screen works like a window: lean left and you see more of the right side of the scene, come closer and you see more around the edges. Sit as you usually do for the first moment after switching it on; that position becomes the middle. Switch it off and on again to set a new middle. The browser asks once for the camera. The face detector (MediaPipe) comes with the viewer; only its small face model loads from the internet the first time. The picture never leaves the computer.

Both work with either renderer and together.

## Headsets

Several VR headsets (for example Meta Quest) can view the scenes at the same time. Each headset picks its own scene, downloads it from this computer over the network and renders it itself.

1. Start the viewer as usual; it always serves headsets on the network too. To keep it to this computer, start it with `--no-lan` (for example `./start.sh --no-lan`).
2. The window shows an address like `https://192.168.1.20:43211`. Open it in the browser on each headset. The computer and the headsets must be in the same network.
3. The browser warns that the connection is not private. Choose "Advanced" and continue. VR in the browser only works over HTTPS, so the viewer creates its own certificate on the first start.
4. Choose a scene and press "VR".

### Hotspot on Linux

On Linux the viewer can open a Wi-Fi hotspot, so headsets connect to this computer directly, without a router. It only does so when started with `--hotspot`, for example `./start.sh --hotspot`. The window shows its name, its password and the address to open, for example `https://10.42.0.1:43211`. A hotspot set up before in NetworkManager is used again, so headsets that know it reconnect by themselves; otherwise the viewer makes one called "Gaussian Viewer", on 5 GHz where the Wi-Fi card allows it.

While the hotspot is on, the Wi-Fi card leaves the network it was on; the computer stays online over a network cable. When the viewer stops, it turns the hotspot off again and the Wi-Fi goes back to its network. A hotspot that was already on before the viewer started stays on. Opening a hotspot needs NetworkManager (`nmcli`), which most desktops have.

If the firewall ufw is on, headsets cannot open the page until the port is allowed once: `sudo ufw allow in on wlp6s0 to any port 43211 proto tcp` (the window shows this line with the name of your Wi-Fi card).

In VR the left stick moves, the right stick up and down changes the depth stretch, and the left trigger and grip move up and down. Push the right stick left or right to switch scenes; X or Y resets the position. While the right stick changes the depth stretch, a card below your line of sight shows the distance factor and where it sits between ×1 and ×4.

To rate the scene you are looking at, pull the right trigger briefly: a card with three stars appears in front of you; point at a star and pull the trigger. Pulling the trigger away from the card closes it.

B opens the scene browser and closes it again. In the browser, point at a scene and pull the trigger to open it, or at the stars on its picture to rate it. Scroll with the right stick, or hold the trigger and drag the list up or down, or grab the scrollbar at the right edge and pull it. "Exit VR" at the top of the browser leaves VR. While a scene loads, a card in front of you shows its progress; B stops loading it and takes you back to the browser. Scenes you have already seen stay in memory for a while, so going back to them is instant.

Windows asks once whether Node.js may accept connections. Allow it for private networks. Everyone in the network can open the address and see the scenes. The scene folder can only be changed on this computer.
