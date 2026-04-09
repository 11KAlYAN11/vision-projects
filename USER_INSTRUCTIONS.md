# Vision Projects — User Instructions

This file explains **exactly how to control the globe**.

## Start

1) Run the app and open it in the browser.
2) Click **Start camera**.
3) When the browser asks, click **Allow** for camera permission.

You should see:

- Your webcam on the left
- A globe on the right
- Status shows **Tracking** when a hand is detected

## Core controls (recommended)

### 1) Tilt (steer + pitch)

- **What you do**: Hold one hand up (palm facing camera) and **tilt it**.
- **What happens**:
  - Tilt **up/down** → globe pitches **up/down**
  - Tilt **left/right** → globe steers **left/right**

Tips:

- Keep your hand roughly centered in the webcam view.
- Strong lighting improves stability.

### 2) Pinch (expand / shrink)

- **What you do**: Pinch **thumb + index** together / apart.
- **What happens**: The globe **expands** as you pinch (and returns when you release).

### 3) Open palm (burst rings)

- **What you do**: Show an **open palm** (4–5 fingers extended).
- **What happens**: A burst-ring animation triggers around the globe.

If you want to verify the animation is working without gestures, click **Test burst** in the globe panel.

## Two-hand animation (scale with hands apart)

- **What you do**: Show **both hands** in the camera view.
- **What happens**:
  - Move hands **apart** → globe grows
  - Move hands **together** → globe shrinks

Notes:

- Two-hand mode activates only when **both hands are visible** to the tracker.
- If one hand drops out of view, it returns to one-hand mode automatically.

## “Mode / Effect” readout

On the left panel you’ll see a readout like:

- `one-hand · scale`
- `two-hand · scale`
- `two-hand · burst`

