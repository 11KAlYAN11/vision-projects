# Vision Projects

Realtime computer-vision + graphics demos built to *wow*.

## Demo 1: Hand Tilt + Pinch Globe

- **Tilt** your hand to steer the globe.
- **Pinch** (thumb + index) to expand it with a glow burst.
- **Open palm** (4–5 fingers) to trigger burst rings.

Tech:

- **Hand tracking**: MediaPipe Tasks Vision `HandLandmarker`
- **Rendering**: Three.js
- **App**: Vite + React + TypeScript

## Run locally

From `vision-projects/`:

```bash
npm install
npm run dev
```

Then open the URL printed in the terminal and **allow camera access**.

## User instructions (gestures)

See `USER_INSTRUCTIONS.md` for the full guide.

Quick start:

1) Click **Start camera** and allow webcam permissions.

2) Try:

- **Tilt**: rotate your hand like a steering wheel → globe rotates/steers.
- **Pinch**: thumb + index pinch open/close → globe expands/shrinks.
- **Open palm**: show 4–5 fingers → burst rings animation.
- **Two hands**: show both hands; move them **apart** to expand and **together** to shrink.

## Globe labels (countries + cities)

The globe includes a small set of pinned labels (countries + major cities). This is a demo dataset and can be expanded to hundreds/thousands (with clustering) if you want.

## Notes

- Works best in **Chrome / Edge**.
- If the model download is blocked by network policy, we can vendor the `.task` model file locally and load it from `public/`.
