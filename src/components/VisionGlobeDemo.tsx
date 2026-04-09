import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import {
  computePinch,
  countExtendedFingers,
  type HandLandmarks,
} from '../lib/handMath'
import { ExpSmoother } from '../lib/smoother'

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'

export function VisionGlobeDemo() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)

  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [cameraOn, setCameraOn] = useState(false)

  const [tiltDeg, setTiltDeg] = useState({ x: 0, y: 0 })
  const [pinch, setPinch] = useState(0)
  const [fingers, setFingers] = useState(0)
  const [mode, setMode] = useState<'none' | 'one-hand' | 'two-hand'>('none')
  const [lastEffect, setLastEffect] = useState<'none' | 'burst' | 'scale'>('none')

  const smoothTiltX = useMemo(() => new ExpSmoother(0.18), [])
  const smoothTiltY = useMemo(() => new ExpSmoother(0.18), [])
  const smoothPinch = useMemo(() => new ExpSmoother(0.12), [])
  const smoothTwoHand = useMemo(() => new ExpSmoother(0.1), [])
  const smoothPosX = useMemo(() => new ExpSmoother(0.12), [])
  const smoothPosY = useMemo(() => new ExpSmoother(0.12), [])

  const lastHandSeenAtMsRef = useRef<number>(0)
  const targetScaleRef = useRef<number>(1)
  const targetRotXRef = useRef<number>(0)
  const targetRotYDeltaRef = useRef<number>(0)

  const three = useRef<{
    renderer: THREE.WebGLRenderer
    labelRenderer: CSS2DRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    globe: THREE.Mesh
    clouds: THREE.Mesh
    glow: THREE.Mesh
    burstGroup: THREE.Group
    orbitGroup: THREE.Group
    markers: THREE.Group
    frameId: number | null
    resizeObserver: ResizeObserver
    triggerBurst: () => void
    triggerMegaBurst: () => void
  } | null>(null)

  const mp = useRef<{
    handLandmarker: HandLandmarker
    rafId: number | null
    lastVideoTime: number
  } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    })
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    el.appendChild(renderer.domElement)

    const labelRenderer = new CSS2DRenderer()
    labelRenderer.domElement.style.position = 'absolute'
    labelRenderer.domElement.style.inset = '0'
    labelRenderer.domElement.style.pointerEvents = 'none'
    labelRenderer.domElement.style.userSelect = 'none'
    el.style.position = 'relative'
    el.appendChild(labelRenderer.domElement)

    const scene = new THREE.Scene()
    scene.background = null

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100)
    camera.position.set(0, 0, 3.2)

    const ambient = new THREE.AmbientLight(0xffffff, 0.65)
    scene.add(ambient)
    const key = new THREE.DirectionalLight(0xffffff, 1.3)
    key.position.set(3, 2, 3)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x8b5cf6, 0.6)
    rim.position.set(-3, 1.5, -2.5)
    scene.add(rim)

    const tex = new THREE.TextureLoader()
    const day = tex.load('/textures/earth_day_2048.jpg')
    day.colorSpace = THREE.SRGBColorSpace
    const bump = tex.load('/textures/earth_bump_2048.jpg')
    const spec = tex.load('/textures/earth_spec_2048.jpg')

    const globeGeo = new THREE.SphereGeometry(1, 128, 128)
    const globeMat = new THREE.MeshPhongMaterial({
      map: day,
      bumpMap: bump,
      bumpScale: 0.04,
      specularMap: spec,
      specular: new THREE.Color('#b7d7ff'),
      shininess: 12,
    })
    const globe = new THREE.Mesh(globeGeo, globeMat)
    scene.add(globe)

    const cloudTex = tex.load('/textures/earth_clouds_1024.png')
    cloudTex.colorSpace = THREE.SRGBColorSpace
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.01, 128, 128),
      new THREE.MeshPhongMaterial({
        map: cloudTex,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    )
    globe.add(clouds)

    // Keep a subtle atmosphere, but avoid visible "grey shade" ring.
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.06, 64, 64),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#7dd3fc'),
        transparent: true,
        opacity: 0.02,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    )
    scene.add(glow)

    const markers = new THREE.Group()
    globe.add(markers)
    addPopularMarkers(markers)

    const burstGroup = new THREE.Group()
    burstGroup.visible = false
    scene.add(burstGroup)
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#93c5fd'),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.12, 1.18, 128),
        ringMat.clone(),
      )
      ring.rotation.x = Math.PI / 2
      burstGroup.add(ring)
    }

    // ── Orbit arcs — the "energy halo" effect visible alongside the globe —──
    const orbitGroup = new THREE.Group()
    scene.add(orbitGroup)
    const orbitDefs = [
      { tiltX: Math.PI / 2, tiltZ: 0, color: '#60a5fa', speed: 0.38, thickness: 0.006 },
      { tiltX: Math.PI / 2 * 0.6, tiltZ: Math.PI / 3, color: '#a78bfa', speed: -0.26, thickness: 0.005 },
      { tiltX: Math.PI / 2 * 0.3, tiltZ: -Math.PI / 5, color: '#38bdf8', speed: 0.19, thickness: 0.004 },
    ]
    const orbitMeshes: { mesh: THREE.Mesh; speed: number }[] = []
    for (const def of orbitDefs) {
      const pivot = new THREE.Object3D()
      pivot.rotation.x = def.tiltX
      pivot.rotation.z = def.tiltZ
      const orb = new THREE.Mesh(
        new THREE.TorusGeometry(1.22, def.thickness, 8, 180),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(def.color),
          transparent: true,
          opacity: 0.12,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      pivot.add(orb)
      orbitGroup.add(pivot)
      orbitMeshes.push({ mesh: orb, speed: def.speed })
    }

    // ── MEGA BURST system — only for Test Burst button ───────────────────────
    // 1. Flash sphere
    const flashSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 32, 32),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ffffff'),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
      }),
    )
    scene.add(flashSphere)

    // 2. Six shockwave rings in rainbow gradient colours
    const megaRingColors = ['#ffffff', '#bfdbfe', '#a78bfa', '#f0abfc', '#fb923c', '#34d399']
    const megaRings: THREE.Mesh[] = []
    for (let i = 0; i < 6; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.0, 1.06 + i * 0.01, 128),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(megaRingColors[i]),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      )
      // Tilt each ring differently so they form a 3-D burst
      ring.rotation.x = (Math.PI / 2) + i * 0.22
      ring.rotation.z = i * 0.38
      scene.add(ring)
      megaRings.push(ring)
    }

    // 3. Colourful flying particles
    const MB_COUNT = 260
    const mbGeo = new THREE.BufferGeometry()
    const mbPos = new Float32Array(MB_COUNT * 3)
    const mbColors = new Float32Array(MB_COUNT * 3)
    const mbVel: THREE.Vector3[] = []
    const mbLife = new Float32Array(MB_COUNT)
    const mbMaxLife = new Float32Array(MB_COUNT)
    const palette = [
      new THREE.Color('#60a5fa'), new THREE.Color('#a78bfa'), new THREE.Color('#f472b6'),
      new THREE.Color('#fb923c'), new THREE.Color('#34d399'), new THREE.Color('#facc15'),
      new THREE.Color('#38bdf8'), new THREE.Color('#ffffff'),
    ]
    for (let i = 0; i < MB_COUNT; i++) {
      mbPos[i * 3] = 0; mbPos[i * 3 + 1] = 0; mbPos[i * 3 + 2] = 0
      mbLife[i] = 0
      mbMaxLife[i] = 0.8 + Math.random() * 0.7
      mbVel.push(new THREE.Vector3())
      const c = palette[Math.floor(Math.random() * palette.length)]
      mbColors[i * 3] = c.r; mbColors[i * 3 + 1] = c.g; mbColors[i * 3 + 2] = c.b
    }
    mbGeo.setAttribute('position', new THREE.BufferAttribute(mbPos, 3))
    mbGeo.setAttribute('color', new THREE.BufferAttribute(mbColors, 3))
    const mbMat = new THREE.PointsMaterial({
      size: 0.055,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const mbPoints = new THREE.Points(mbGeo, mbMat)
    scene.add(mbPoints)

    let megaBurstT = -1 // -1 = not active
    const triggerMegaBurst = () => {
      megaBurstT = 0
      // Spawn particles from globe surface
      for (let i = 0; i < MB_COUNT; i++) {
        const theta = Math.random() * Math.PI * 2
        const phi = Math.acos(2 * Math.random() - 1)
        const r = 1.02
        const x = r * Math.sin(phi) * Math.cos(theta)
        const y = r * Math.sin(phi) * Math.sin(theta)
        const z = r * Math.cos(phi)
        mbPos[i * 3] = x; mbPos[i * 3 + 1] = y; mbPos[i * 3 + 2] = z
        mbLife[i] = 1.0
        mbMaxLife[i] = 0.6 + Math.random() * 0.9
        const speed = 1.5 + Math.random() * 3.5
        mbVel[i].set(x, y, z).normalize().multiplyScalar(speed)
        // Add random tangential scatter for organic spread
        mbVel[i].x += (Math.random() - 0.5) * 1.2
        mbVel[i].y += (Math.random() - 0.5) * 1.2
        mbVel[i].z += (Math.random() - 0.5) * 1.2
      }
      mbGeo.attributes.position.needsUpdate = true
      // Reset rings
      for (const ring of megaRings) {
        ring.scale.setScalar(1)
          ; (ring.material as THREE.MeshBasicMaterial).opacity = 0
      }
    }

    const stars = makeStarfield()
    scene.add(stars)

    const resize = () => {
      const r = el.getBoundingClientRect()
      const w = Math.max(1, Math.floor(r.width))
      const h = Math.max(1, Math.floor(r.height))
      renderer.setSize(w, h, false)
      labelRenderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(el)
    resize()

    let t0 = performance.now()
    let burstT = 0

    // Expose a safe burst trigger that always resets burstT
    const triggerBurst = () => {
      burstT = 0
      burstGroup.visible = true
      for (const child of burstGroup.children) {
        const m = (child as THREE.Mesh).material as THREE.MeshBasicMaterial
        m.opacity = 0.22
      }
    }

    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - t0) / 1000)
      t0 = t

      const handPresent = t - lastHandSeenAtMsRef.current < 250

      // Base spin (slowed another 30%) - only when hand is present
      if (handPresent) {
        globe.rotation.y += dt * 0.1078
        clouds.rotation.y += dt * 0.1568
      }
      stars.rotation.y += dt * 0.02

      // Apply target pitch/yaw smoothly (easy up/down control).
      globe.rotation.x = THREE.MathUtils.lerp(globe.rotation.x, targetRotXRef.current, 0.16)
      globe.rotation.y += targetRotYDeltaRef.current
      targetRotYDeltaRef.current *= 0.85

      // Always settle scale smoothly back to target
      const scaleTarget = targetScaleRef.current
      const s = THREE.MathUtils.lerp(globe.scale.x, scaleTarget, 0.12)
      globe.scale.setScalar(s)

      // burst animation
      if (burstGroup.visible) {
        burstT += dt
        const k = Math.min(1, burstT / 0.55)
        const e = 1 - Math.pow(1 - k, 3)
        burstGroup.scale.setScalar(1 + e * 0.65)
        for (let i = 0; i < burstGroup.children.length; i++) {
          const m = (burstGroup.children[i] as THREE.Mesh)
            .material as THREE.MeshBasicMaterial
          m.opacity = (1 - k) * (0.22 - i * 0.04)
          burstGroup.children[i].rotation.z += dt * (0.7 + i * 0.35)
        }
        if (k >= 1) {
          burstGroup.visible = false
          burstT = 0
          burstGroup.scale.setScalar(1)
          for (const child of burstGroup.children) {
            const m = (child as THREE.Mesh).material as THREE.MeshBasicMaterial
            m.opacity = 0
          }
        }
      }

      // Orbit arc animation — always spin, pulse opacity with hand presence
      const orbitTarget = handPresent ? 0.55 : 0.12
      for (let i = 0; i < orbitMeshes.length; i++) {
        const om = orbitMeshes[i]
        om.mesh.parent!.rotation.y += dt * om.speed
        const mat = om.mesh.material as THREE.MeshBasicMaterial
        mat.opacity = THREE.MathUtils.lerp(mat.opacity, orbitTarget - i * 0.1, 0.06)
      }

      // ── MEGA BURST animation ─────────────────────────────────────────────
      if (megaBurstT >= 0) {
        megaBurstT += dt
        const dur = 1.8
        const k = Math.min(1, megaBurstT / dur)

        // Flash sphere: bright white burst that fades in first 15% then out
        const flashK = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85
          ; (flashSphere.material as THREE.MeshBasicMaterial).opacity = flashK * 0.65

        // ── "Coming out of the screen" ──────────────────────────────────────
        // Phase 1 (k 0‒0.35): easeOutCubic lunge toward camera
        // Phase 2 (k 0.35‒1): easeInOutQuad pull smoothly back
        const lunge = (() => {
          if (k < 0.35) {
            const t = k / 0.35
            return 1 - Math.pow(1 - t, 3) // easeOutCubic
          } else {
            const t = (k - 0.35) / 0.65
            return 1 - (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) // easeInOutQuad
          }
        })()
        const MAX_Z = 1.55 // camera sits at z=3.2, globe starts at 0 — 1.55 is dramatic but safe
        globe.position.z = lunge * MAX_Z
        globe.scale.setScalar(1 + lunge * 0.24) // subtle scale reinforces depth
        // Widen FOV during approach for fisheye rush
        camera.fov = 55 + lunge * 22
        camera.updateProjectionMatrix()

        // Shockwave rings: each launches with a small delay
        for (let i = 0; i < megaRings.length; i++) {
          const delay = i * 0.07
          const rk = Math.max(0, Math.min(1, (megaBurstT - delay) / (dur * 0.75)))
          if (rk <= 0) continue
          const re = 1 - Math.pow(1 - rk, 2.5)
          megaRings[i].scale.setScalar(1 + re * (2.8 + i * 0.4))
            ; (megaRings[i].material as THREE.MeshBasicMaterial).opacity = (1 - rk) * (0.65 - i * 0.07)
          megaRings[i].rotation.z += dt * (0.4 + i * 0.15)
        }

        // Flying particles
        for (let i = 0; i < MB_COUNT; i++) {
          if (mbLife[i] <= 0) continue
          mbLife[i] -= dt / mbMaxLife[i]
          if (mbLife[i] < 0) mbLife[i] = 0
          mbPos[i * 3] += mbVel[i].x * dt
          mbPos[i * 3 + 1] += mbVel[i].y * dt
          mbPos[i * 3 + 2] += mbVel[i].z * dt
          mbVel[i].multiplyScalar(0.96)
        }
        mbGeo.attributes.position.needsUpdate = true
        mbMat.opacity = k < 0.12 ? k / 0.12 : Math.max(0, 1 - (k - 0.12) / 0.88)
        mbMat.opacity *= 0.9

        if (k >= 1) {
          megaBurstT = -1
          globe.position.z = 0
          globe.scale.setScalar(targetScaleRef.current)
          camera.fov = 55
          camera.updateProjectionMatrix()
            ; (flashSphere.material as THREE.MeshBasicMaterial).opacity = 0
          for (const ring of megaRings) {
            ; (ring.material as THREE.MeshBasicMaterial).opacity = 0
            ring.scale.setScalar(1)
          }
          mbMat.opacity = 0
          for (let i = 0; i < MB_COUNT; i++) mbLife[i] = 0
        }
      }

      renderer.render(scene, camera)
      labelRenderer.render(scene, camera)

      // Hide labels on the back side so they don't look like they're floating in space.
      updateMarkerLabelVisibility(camera, globe, markers)

      const frameId = requestAnimationFrame(tick)
      if (three.current) three.current.frameId = frameId
    }
    const frameId = requestAnimationFrame(tick)

    three.current = {
      renderer,
      labelRenderer,
      scene,
      camera,
      globe,
      clouds,
      glow,
      burstGroup,
      orbitGroup,
      markers,
      frameId,
      resizeObserver,
      triggerBurst,
      triggerMegaBurst,
    }

    return () => {
      if (three.current?.frameId) cancelAnimationFrame(three.current.frameId)
      resizeObserver.disconnect()
      renderer.dispose()
      labelRenderer.domElement.remove()
      globeGeo.dispose()
      globeMat.dispose()
      glow.geometry.dispose()
        ; (glow.material as THREE.Material).dispose()
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose?.()
        if (mesh.material) {
          const m = mesh.material as THREE.Material | THREE.Material[]
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose())
          else m.dispose()
        }
      })
      renderer.domElement.remove()
      three.current = null
    }
  }, [])

  useEffect(() => {
    if (!cameraOn) return

    let stopped = false

    async function start() {
      try {
        setStatus({ kind: 'loading' })

        const video = videoRef.current
        const overlay = overlayRef.current
        if (!video || !overlay) throw new Error('Video elements not ready')

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
        if (stopped) return
        video.srcObject = stream
        await video.play()

        const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
        if (stopped) return

        const handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        })

        mp.current = { handLandmarker, rafId: null, lastVideoTime: -1 }
        setStatus({ kind: 'ready' })

        const ctx = overlay.getContext('2d')
        if (!ctx) throw new Error('2D canvas not available')

        const loop = () => {
          if (stopped) return
          const mpState = mp.current
          const threeState = three.current
          const v = videoRef.current
          const c = overlayRef.current
          if (!mpState || !threeState || !v || !c) return

          const vw = v.videoWidth || 0
          const vh = v.videoHeight || 0
          if (vw > 0 && vh > 0) {
            if (c.width !== vw || c.height !== vh) {
              c.width = vw
              c.height = vh
            }

            if (mpState.lastVideoTime !== v.currentTime) {
              mpState.lastVideoTime = v.currentTime
              const res = mpState.handLandmarker.detectForVideo(v, performance.now())
              const lmsA = (res.landmarks?.[0] ?? null) as HandLandmarks | null
              const lmsB = (res.landmarks?.[1] ?? null) as HandLandmarks | null

              ctx.clearRect(0, 0, c.width, c.height)
              if (lmsA) drawLandmarks(ctx, lmsA, c.width, c.height)
              if (lmsB) drawLandmarks(ctx, lmsB, c.width, c.height)

              // Two-hand gesture: distance between wrists controls scale.
              if (lmsA && lmsB) {
                lastHandSeenAtMsRef.current = performance.now()
                setMode('two-hand')
                const d = Math.hypot(lmsA[0].x - lmsB[0].x, lmsA[0].y - lmsB[0].y)
                const norm = clamp01((d - 0.18) / (0.65 - 0.18))
                const p2 = smoothTwoHand.next(norm)
                targetScaleRef.current = 1 + p2 * 0.95
                setLastEffect('scale')

                const fA = countExtendedFingers(lmsA)
                const fB = countExtendedFingers(lmsB)
                setFingers(Math.max(fA, fB))
                if (fA >= 4 && fB >= 4 && !threeState.burstGroup.visible) {
                  threeState.triggerBurst()
                  setLastEffect('burst')
                }
              }

              // Single-hand gestures
              if (lmsA && !lmsB) {
                lastHandSeenAtMsRef.current = performance.now()
                setMode('one-hand')
                const pinchRaw = computePinch(lmsA)
                const fingerCount = countExtendedFingers(lmsA)

                // Position-based control (more reliable than tilt math on webcam):
                // move hand up/down to pitch the globe, left/right to steer.
                const wrist = lmsA[0]
                const px = smoothPosX.next(wrist ? wrist.x : 0.5)
                const py = smoothPosY.next(wrist ? wrist.y : 0.5)

                const tx = smoothTiltX.next((0.5 - py) * 75) // pitch degrees
                const ty = smoothTiltY.next((px - 0.5) * 70) // steer degrees
                const p = smoothPinch.next(pinchRaw)

                setTiltDeg({ x: tx, y: ty })
                setPinch(p)
                setFingers(fingerCount)
                setLastEffect('scale')

                const rotX = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(tx, -38, 38))
                const rotY = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(ty, -34, 34))
                targetRotXRef.current = rotX
                // If only 1 finger is extended, treat it like a "precision steer"
                const steerGain = fingerCount <= 1 ? 0.028 : 0.018
                targetRotYDeltaRef.current += rotY * steerGain
                targetRotYDeltaRef.current = THREE.MathUtils.clamp(
                  targetRotYDeltaRef.current,
                  -0.04,
                  0.04,
                )

                const s = 1 + THREE.MathUtils.clamp(p, 0, 1) * 0.85
                const eased = easeOutCubic(s)
                targetScaleRef.current = eased
                // Keep atmosphere subtle; do NOT ramp opacity (it shows as a grey ring).
                threeState.glow.scale.setScalar(1.06)
                  ; (threeState.glow.material as THREE.MeshBasicMaterial).opacity = 0.02

                // Open palm burst (4-5 extended fingers)
                if (fingerCount >= 4 && !threeState.burstGroup.visible) {
                  threeState.triggerBurst()
                  setLastEffect('burst')
                }
              }
              if (!lmsA && !lmsB) {
                // No hand detected in this frame; settle back.
                setMode('none')
                setLastEffect('none')
                targetScaleRef.current = 1
                targetRotYDeltaRef.current = 0
              }
            }
          }

          mpState.rafId = requestAnimationFrame(loop)
        }
        loop()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus({ kind: 'error', message: msg })
      }
    }

    void start()

    return () => {
      stopped = true
      const mpState = mp.current
      if (mpState?.rafId) cancelAnimationFrame(mpState.rafId)
      mp.current = null

      const v = videoRef.current
      const stream = v?.srcObject as MediaStream | null
      stream?.getTracks()?.forEach((t) => t.stop())
      if (v) v.srcObject = null
    }
  }, [cameraOn, smoothPinch, smoothTiltX, smoothTiltY])

  return (
    <div className="demoGrid">
      <section className="panel">
        <div className="panelHeader">
          <div>
            <div className="panelTitle">Hand Input</div>
            <div className="panelSub">Start camera, then try the gestures below.</div>
          </div>
          <button
            className="btn"
            onClick={() => setCameraOn((v) => !v)}
            aria-pressed={cameraOn}
          >
            {cameraOn ? 'Stop camera' : 'Start camera'}
          </button>
        </div>

        <div className="cameraStage">
          <video ref={videoRef} className="video" playsInline muted />
          <canvas ref={overlayRef} className="overlay" />
          <div className="cameraChrome" />
          <div className="statusPill">
            {status.kind === 'idle' && 'Idle'}
            {status.kind === 'loading' && 'Loading hand model…'}
            {status.kind === 'ready' && 'Tracking'}
            {status.kind === 'error' && `Error: ${status.message}`}
          </div>
        </div>

        <div className="helpBox">
          <div className="helpTitle">How to use</div>
          <ul className="helpList">
            <li>
              <b>Tilt</b> your hand → steer the globe
            </li>
            <li>
              <b>Pinch</b> (thumb + index) → expand / shrink
            </li>
            <li>
              <b>Open palm</b> (4–5 fingers) → burst rings
            </li>
          </ul>
        </div>

        <div className="readout">
          <div className="readoutItem">
            <div className="readoutLabel">Tilt X</div>
            <div className="readoutValue">{tiltDeg.x.toFixed(1)}°</div>
          </div>
          <div className="readoutItem">
            <div className="readoutLabel">Tilt Y</div>
            <div className="readoutValue">{tiltDeg.y.toFixed(1)}°</div>
          </div>
          <div className="readoutItem">
            <div className="readoutLabel">Mode / Effect</div>
            <div className="readoutValue">
              {mode} · {lastEffect}
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <div className="panelTitle">Globe</div>
            <div className="panelSub">Three.js scene driven by your hand.</div>
          </div>
          <button
            className="btn"
            onClick={() => {
              const s = three.current
              if (!s) return
              s.triggerMegaBurst()
              setLastEffect('burst')
            }}
          >
            Test burst
          </button>
        </div>
        <div className="globeStage" ref={containerRef} />
      </section>
    </div>
  )
}

function easeOutCubic(x: number) {
  const t = THREE.MathUtils.clamp(x, 0.85, 1.85)
  const u = (t - 0.85) / (1.85 - 0.85)
  return 0.85 + (1 - Math.pow(1 - u, 3)) * (1.85 - 0.85)
}

function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  lms: HandLandmarks,
  w: number,
  h: number,
) {
  ctx.save()
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(96,165,250,0.6)'
  ctx.fillStyle = 'rgba(167,139,250,0.8)'

  const pts = lms.map((p) => ({ x: p.x * w, y: p.y * h }))

  const fingers = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20],
  ]
  for (const chain of fingers) {
    ctx.beginPath()
    for (let i = 0; i < chain.length; i++) {
      const p = pts[chain[i]]
      if (!p) continue
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
  }

  for (const p of pts) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

function makeStarfield() {
  const g = new THREE.BufferGeometry()
  const count = 900
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const r = 22 * Math.random() + 8
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const x = r * Math.sin(phi) * Math.cos(theta)
    const y = r * Math.sin(phi) * Math.sin(theta)
    const z = r * Math.cos(phi)
    pos[i * 3 + 0] = x
    pos[i * 3 + 1] = y
    pos[i * 3 + 2] = z
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const m = new THREE.PointsMaterial({
    size: 0.035,
    color: new THREE.Color('#e9d5ff'),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  })
  return new THREE.Points(g, m)
}

function addPopularMarkers(group: THREE.Group) {
  const entries: Array<{ label: string; lat: number; lon: number; kind: 'country' | 'city' }> = [
    { label: 'USA', lat: 39.8, lon: -98.6, kind: 'country' },
    { label: 'India', lat: 22.5, lon: 78.9, kind: 'country' },
    { label: 'China', lat: 35.9, lon: 104.2, kind: 'country' },
    { label: 'Brazil', lat: -14.2, lon: -51.9, kind: 'country' },
    { label: 'UK', lat: 55.4, lon: -3.4, kind: 'country' },
    { label: 'Japan', lat: 36.2, lon: 138.3, kind: 'country' },
    { label: 'Germany', lat: 51.2, lon: 10.4, kind: 'country' },
    { label: 'UAE', lat: 24.3, lon: 54.3, kind: 'country' },
    { label: 'New York', lat: 40.7128, lon: -74.006, kind: 'city' },
    { label: 'London', lat: 51.5072, lon: -0.1276, kind: 'city' },
    { label: 'Dubai', lat: 25.2048, lon: 55.2708, kind: 'city' },
    { label: 'Mumbai', lat: 19.076, lon: 72.8777, kind: 'city' },
    { label: 'Delhi', lat: 28.6139, lon: 77.209, kind: 'city' },
    { label: 'Tokyo', lat: 35.6762, lon: 139.6503, kind: 'city' },
    { label: 'Singapore', lat: 1.3521, lon: 103.8198, kind: 'city' },
    { label: 'São Paulo', lat: -23.5558, lon: -46.6396, kind: 'city' },
  ]

  for (const e of entries) {
    const p = latLonToVec3(e.lat, e.lon, 1.004)
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(e.kind === 'city' ? 0.010 : 0.013, 10, 10),
      new THREE.MeshBasicMaterial({
        color: e.kind === 'city' ? new THREE.Color('#93c5fd') : new THREE.Color('#a78bfa'),
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    )
    dot.position.copy(p)
    group.add(dot)

    const div = document.createElement('div')
    div.className = `globeLabel ${e.kind}`
    div.textContent = e.label
    const labelObj = new CSS2DObject(div)
    // Small outward offset along normal so it feels "attached" to the surface.
    labelObj.position.copy(p.clone().normalize().multiplyScalar(0.05))
    dot.add(labelObj)
  }
}

function latLonToVec3(lat: number, lon: number, radius: number) {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  const x = -radius * Math.sin(phi) * Math.cos(theta)
  const z = radius * Math.sin(phi) * Math.sin(theta)
  const y = radius * Math.cos(phi)
  return new THREE.Vector3(x, y, z)
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}

function updateMarkerLabelVisibility(
  camera: THREE.Camera,
  globe: THREE.Object3D,
  markers: THREE.Group,
) {
  const globeCenter = new THREE.Vector3()
  globe.getWorldPosition(globeCenter)

  const camPos = new THREE.Vector3()
  camera.getWorldPosition(camPos)

  const dotWorld = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const camDir = new THREE.Vector3()

  for (const child of markers.children) {
    const dot = child as THREE.Object3D
    dot.getWorldPosition(dotWorld)

    normal.copy(dotWorld).sub(globeCenter).normalize()
    camDir.copy(camPos).sub(dotWorld).normalize()

    // If dot is facing away from the camera, hide label.
    const facing = normal.dot(camDir)
    const label = dot.children.find((c) => (c as unknown as { isCSS2DObject?: boolean }).isCSS2DObject)
    const el = (label as CSS2DObject | undefined)?.element
    if (el) {
      el.style.opacity = facing > 0 ? '1' : '0'
    }
  }
}

