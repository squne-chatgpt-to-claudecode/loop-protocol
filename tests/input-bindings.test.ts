/**
 * tests/input-bindings.test.ts
 *
 * Unit tests for pointer hover tracking (AC1) added in Issue #580.
 * Tests that aim coordinates update on pointermove independent of activePointerId.
 *
 * Also covers Issue #982 AC5/AC6:
 *   - KeyZ → assist_player rising-edge sampling
 *   - event.repeat guard
 *   - keyup / blur / visibilitychange hidden clears assistPlayerPressed
 */
import { describe, expect, it, vi } from 'vitest'

import { bindInput, createInputState, mapInputToCommands } from '../src/input'
import { ASSIST_PLAYER_KEY_CODE } from '../src/input/InputBindings'
import type { CanvasLike, KeyEventTarget, VisibilityTarget } from '../src/input/InputBindings'

// ---------------------------------------------------------------------------
// Test stubs
// ---------------------------------------------------------------------------

function makeFakeKeyTarget(): KeyEventTarget {
  return {
    addEventListener() {
      // no-op stub: keyboard events are not under test in this file
    },
  }
}

function makeFakeCanvas(boundsOverride?: { left: number; top: number; width: number; height: number }): CanvasLike & {
  dispatchPointer(type: string, overrides?: Partial<{
    pointerId: number
    isPrimary: boolean
    button: number
    clientX: number
    clientY: number
  }>): void
  setPointerCaptureSpy: ReturnType<typeof vi.fn>
} {
  const listeners = new Map<string, EventListener[]>()
  const setPointerCaptureSpy = vi.fn()
  const bounds = boundsOverride ?? { left: 0, top: 0, width: 960, height: 540 }

  return {
    getBoundingClientRect: vi.fn(() => bounds),
    setPointerCapture: setPointerCaptureSpy,
    setPointerCaptureSpy,
    addEventListener(type: string, handler: EventListener) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type)!.push(handler)
    },
    dispatchPointer(type: string, overrides = {}) {
      const event = {
        type,
        pointerId: overrides.pointerId ?? 1,
        isPrimary: overrides.isPrimary ?? true,
        button: overrides.button ?? 0,
        clientX: overrides.clientX ?? 0,
        clientY: overrides.clientY ?? 0,
      } as PointerEvent
      for (const h of listeners.get(type) ?? []) h(event)
    },
  }
}

// ---------------------------------------------------------------------------
// Hover / pointermove tracking (AC1)
// ---------------------------------------------------------------------------

describe('pointer hover tracking — AC1 (pointerKnown + pointermove always processed)', () => {
  it('GIVEN fresh input state WHEN created THEN pointerKnown is false', () => {
    const input = createInputState()
    expect(input.pointerKnown).toBe(false)
  })

  it('GIVEN no pointerdown WHEN primary pointermove THEN pointerX/Y updates and pointerKnown becomes true', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 480, clientY: 270 })

    expect(input.pointerX).toBeCloseTo(480)
    expect(input.pointerY).toBeCloseTo(270)
    expect(input.pointerKnown).toBe(true)
  })

  it('GIVEN pointerdown active WHEN primary pointermove THEN aim still updates', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    canvas.dispatchPointer('pointerdown', { isPrimary: true, button: 0, pointerId: 1 })
    canvas.dispatchPointer('pointermove', { isPrimary: true, pointerId: 1, clientX: 200, clientY: 100 })

    expect(input.pointerX).toBeCloseTo(200)
    expect(input.pointerY).toBeCloseTo(100)
    expect(input.pointerKnown).toBe(true)
  })

  it('GIVEN non-primary pointermove WHEN dispatched THEN pointerX/Y unchanged and pointerKnown remains false', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    input.pointerX = 50
    input.pointerY = 50
    canvas.dispatchPointer('pointermove', { isPrimary: false, clientX: 999, clientY: 999 })

    expect(input.pointerX).toBe(50)
    expect(input.pointerY).toBe(50)
    expect(input.pointerKnown).toBe(false)
  })

  it('GIVEN canvas with offset bounds WHEN pointermove at clientX=100 THEN pointerX is correctly mapped', () => {
    const canvas = makeFakeCanvas({ left: 40, top: 20, width: 480, height: 270 })
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    // clientX=40+48=88 maps to (48/480)*960 = 96
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 88, clientY: 47 })

    expect(input.pointerX).toBeCloseTo(96)
    // clientY=47-20=27; (27/270)*540 = 54
    expect(input.pointerY).toBeCloseTo(54)
    expect(input.pointerKnown).toBe(true)
  })

  it('GIVEN a CSS-scaled canvas WHEN pointer visits each corner and centre THEN it maps to fixed logical coordinates', () => {
    const canvas = makeFakeCanvas({ left: 50, top: 30, width: 1440, height: 810 })
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    const points = [
      { clientX: 50, clientY: 30, x: 0, y: 0 },
      { clientX: 1490, clientY: 30, x: 960, y: 0 },
      { clientX: 50, clientY: 840, x: 0, y: 540 },
      { clientX: 1490, clientY: 840, x: 960, y: 540 },
      { clientX: 770, clientY: 435, x: 480, y: 270 },
    ]

    for (const point of points) {
      canvas.dispatchPointer('pointermove', { isPrimary: true, ...point })
      expect(input.pointerX).toBeCloseTo(point.x)
      expect(input.pointerY).toBeCloseTo(point.y)
    }
  })

  it('GIVEN a zero-sized canvas bounds WHEN pointer moves THEN pointerX/Y stay at the prior finite value (Issue #1956 fix 4)', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 480, clientY: 270 })
    expect(input.pointerX).toBeCloseTo(480)
    expect(input.pointerY).toBeCloseTo(270)

    // Simulate the Canvas becoming zero-sized (e.g. mid-layout-transition,
    // temporarily detached from the render tree).
    vi.mocked(canvas.getBoundingClientRect).mockReturnValue({ left: 0, top: 0, width: 0, height: 0 })
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 900, clientY: 500 })

    expect(input.pointerX).toBeCloseTo(480)
    expect(input.pointerY).toBeCloseTo(270)
    expect(Number.isFinite(input.pointerX)).toBe(true)
    expect(Number.isFinite(input.pointerY)).toBe(true)

    // Simulate a zero-height (but non-zero-width) Canvas — the same guard
    // must apply independently to width and height.
    vi.mocked(canvas.getBoundingClientRect).mockReturnValue({ left: 0, top: 0, width: 960, height: 0 })
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 100, clientY: 100 })
    expect(input.pointerX).toBeCloseTo(480)
    expect(input.pointerY).toBeCloseTo(270)
  })

  it('GIVEN multiple pointermoves WHEN dispatched THEN each updates coordinates', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 100, clientY: 50 })
    expect(input.pointerX).toBeCloseTo(100)

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 300, clientY: 200 })
    expect(input.pointerX).toBeCloseTo(300)
    expect(input.pointerY).toBeCloseTo(200)
  })
})

// ---------------------------------------------------------------------------
// Non-finite pointer input guard: NaN/Infinity coords, bounds, arena
// ---------------------------------------------------------------------------

describe('pointer non-finite input guard — NaN/Infinity never reach pointerX/Y', () => {
  it('GIVEN a fresh input WHEN primary pointermove has NaN clientX/Y THEN pointerKnown stays false and pointerX/Y are unchanged', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())
    const initialX = input.pointerX
    const initialY = input.pointerY

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: Number.NaN, clientY: Number.NaN })

    expect(input.pointerKnown).toBe(false)
    expect(input.pointerX).toBe(initialX)
    expect(input.pointerY).toBe(initialY)
    expect(mapInputToCommands(input).some((c) => c.type === 'aim')).toBe(false)
  })

  it('GIVEN a known pointer WHEN pointermove has NaN or Infinity in only one axis THEN the last good coordinates are kept', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 480, clientY: 270 })

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 100, clientY: Number.NaN })
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: Number.POSITIVE_INFINITY, clientY: 100 })

    expect(input.pointerX).toBe(480)
    expect(input.pointerY).toBe(270)
    expect(input.pointerKnown).toBe(true)
  })

  it('GIVEN a fresh input WHEN pointerdown has NaN coords THEN fire is pressed but pointerKnown stays false', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    canvas.dispatchPointer('pointerdown', {
      isPrimary: true, button: 0, pointerId: 7, clientX: Number.NaN, clientY: Number.NaN,
    })

    expect(input.primaryPressed).toBe(true)
    expect(input.activePointerId).toBe(7)
    expect(canvas.setPointerCaptureSpy).toHaveBeenCalledWith(7)
    expect(input.pointerKnown).toBe(false)
    expect(Number.isFinite(input.pointerX)).toBe(true)
    expect(Number.isFinite(input.pointerY)).toBe(true)
  })

  it.each([
    ['NaN width', { left: 0, top: 0, width: Number.NaN, height: 540 }],
    ['NaN height', { left: 0, top: 0, width: 960, height: Number.NaN }],
    ['Infinity width', { left: 0, top: 0, width: Number.POSITIVE_INFINITY, height: 540 }],
    ['Infinity height', { left: 0, top: 0, width: 960, height: Number.POSITIVE_INFINITY }],
    ['NaN left', { left: Number.NaN, top: 0, width: 960, height: 540 }],
    ['-Infinity top', { left: 0, top: Number.NEGATIVE_INFINITY, width: 960, height: 540 }],
  ])('GIVEN a known pointer WHEN canvas bounds have %s THEN pointerX/Y keep the prior finite value', (_label, bounds) => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 480, clientY: 270 })

    vi.mocked(canvas.getBoundingClientRect).mockReturnValue(bounds)
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 100, clientY: 100 })

    expect(input.pointerX).toBe(480)
    expect(input.pointerY).toBe(270)
  })

  it.each([
    ['NaN width', { width: Number.NaN, height: 540 }],
    ['NaN height', { width: 960, height: Number.NaN }],
    ['Infinity width', { width: Number.POSITIVE_INFINITY, height: 540 }],
    ['Infinity height', { width: 960, height: Number.POSITIVE_INFINITY }],
  ])('GIVEN a fresh input WHEN arena has %s THEN pointermove leaves pointer unknown and finite', (_label, arena) => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => arena, makeFakeKeyTarget())

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 100, clientY: 100 })

    expect(input.pointerKnown).toBe(false)
    expect(Number.isFinite(input.pointerX)).toBe(true)
    expect(Number.isFinite(input.pointerY)).toBe(true)
  })

  it.each([
    ['zero width', { width: 0, height: 540 }],
    ['zero height', { width: 960, height: 0 }],
    ['negative width', { width: -960, height: 540 }],
    ['negative height', { width: 960, height: -540 }],
  ])('GIVEN a fresh input WHEN arena has %s THEN pointermove and pointerdown leave pointer unknown', (_label, arena) => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => arena, makeFakeKeyTarget())
    const initialX = input.pointerX
    const initialY = input.pointerY

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 100, clientY: 100 })
    canvas.dispatchPointer('pointerdown', { isPrimary: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 })

    expect(input.pointerKnown).toBe(false)
    expect(input.pointerX).toBe(initialX)
    expect(input.pointerY).toBe(initialY)
    expect(input.primaryPressed).toBe(true)
  })

  it('GIVEN a known pointer WHEN arena becomes zero then negative THEN pointerX/Y keep the prior value and pointerKnown stays true', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    let arena = { width: 960, height: 540 }
    bindInput(canvas, input, () => arena, makeFakeKeyTarget())
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 480, clientY: 270 })

    arena = { width: 0, height: 0 }
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 100, clientY: 100 })
    expect(input.pointerX).toBe(480)
    expect(input.pointerY).toBe(270)

    arena = { width: -960, height: -540 }
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 100, clientY: 100 })
    expect(input.pointerX).toBe(480)
    expect(input.pointerY).toBe(270)
    expect(input.pointerKnown).toBe(true)
  })

  it('GIVEN an unknown pointer after a zero-sized arena WHEN the arena becomes valid THEN the next pointermove updates coordinates and pointerKnown', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    let arena = { width: 0, height: 0 }
    bindInput(canvas, input, () => arena, makeFakeKeyTarget())

    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 200, clientY: 100 })
    expect(input.pointerKnown).toBe(false)

    arena = { width: 960, height: 540 }
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 200, clientY: 100 })

    expect(input.pointerKnown).toBe(true)
    expect(input.pointerX).toBeCloseTo(200)
    expect(input.pointerY).toBeCloseTo(100)
  })

  it('GIVEN an unknown pointer after rejected NaN pointerdown WHEN a later valid pointermove arrives THEN coordinates update and pointerKnown becomes true', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    let arena = { width: Number.NaN, height: 540 }
    bindInput(canvas, input, () => arena, makeFakeKeyTarget())

    canvas.dispatchPointer('pointerdown', {
      isPrimary: true, button: 0, pointerId: 1, clientX: Number.NaN, clientY: 10,
    })
    canvas.dispatchPointer('pointermove', { isPrimary: true, pointerId: 1, clientX: 200, clientY: 100 })
    expect(input.pointerKnown).toBe(false)

    arena = { width: 960, height: 540 }
    canvas.dispatchPointer('pointermove', { isPrimary: true, pointerId: 1, clientX: 200, clientY: 100 })

    expect(input.pointerKnown).toBe(true)
    expect(input.pointerX).toBeCloseTo(200)
    expect(input.pointerY).toBeCloseTo(100)
    const commands = mapInputToCommands(input)
    expect(commands.find((c) => c.type === 'aim')).toMatchObject({ type: 'aim', x: 200, y: 100 })
    expect(commands.some((c) => c.type === 'fire')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// BLOCKER-3 regression tests: lastAimDirection bug detection
// ---------------------------------------------------------------------------

describe('BLOCKER-3 regression — aim direction priority and pointerdown pointerKnown', () => {
  it('GIVEN no fire WHEN pointermove only THEN aim command is emitted by InputMapper (AC1)', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    // pointermove only — no pointerdown, no fire
    canvas.dispatchPointer('pointermove', { isPrimary: true, clientX: 400, clientY: 300 })

    const commands = mapInputToCommands(input)
    expect(commands.some((c) => c.type === 'aim')).toBe(true)
    expect(commands.find((c) => c.type === 'aim')).toMatchObject({
      type: 'aim',
      x: 400,
      y: 300,
    })
  })

  it('GIVEN first pointerdown WHEN dispatched THEN pointerKnown becomes true and aim+fire can coexist', () => {
    const canvas = makeFakeCanvas()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), makeFakeKeyTarget())

    // First event is pointerdown (no prior pointermove)
    canvas.dispatchPointer('pointerdown', { isPrimary: true, button: 0, pointerId: 1, clientX: 500, clientY: 250 })

    expect(input.pointerKnown).toBe(true)
    const commands = mapInputToCommands(input)
    expect(commands.some((c) => c.type === 'aim')).toBe(true)
    expect(commands.some((c) => c.type === 'fire')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Issue #982 AC5/AC6: KeyZ → assist_player intent binding
// ---------------------------------------------------------------------------

/**
 * Builds a testable KeyEventTarget that supports emit() for keydown/keyup.
 */
function makeKeyTarget(): KeyEventTarget & {
  emit(type: 'keydown' | 'keyup', code: string, repeat?: boolean): void
} {
  const listeners = new Map<string, Array<(event: KeyboardEvent) => void>>()
  return {
    addEventListener(type: 'keydown' | 'keyup', handler: (e: KeyboardEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type)!.push(handler)
    },
    emit(type: 'keydown' | 'keyup', code: string, repeat = false) {
      for (const h of listeners.get(type) ?? []) {
        h({ code, repeat } as KeyboardEvent)
      }
    },
  }
}

/**
 * Fake blur target for testing AC6 blur behavior.
 */
function makeBlurTarget(): { addEventListener(type: 'blur', handler: () => void): void; triggerBlur(): void } {
  const handlers: Array<() => void> = []
  return {
    addEventListener(_type: 'blur', handler: () => void) {
      handlers.push(handler)
    },
    triggerBlur() {
      for (const h of handlers) h()
    },
  }
}

/**
 * Fake visibility target for testing AC6 visibilitychange behavior.
 */
function makeVisibilityTarget(hidden = false): VisibilityTarget & { setHidden(h: boolean): void; triggerChange(): void } {
  const handlers: Array<() => void> = []
  let _hidden = hidden
  return {
    get hidden() { return _hidden },
    addEventListener(_type: 'visibilitychange', handler: () => void) {
      handlers.push(handler)
    },
    setHidden(h: boolean) { _hidden = h },
    triggerChange() {
      for (const h of handlers) h()
    },
  }
}

describe('AC5/AC6 – KeyZ → assist_player intent sampling (Issue #982)', () => {
  it('GIVEN fresh InputState WHEN created THEN assistPlayerPressed and risingEdge are false', () => {
    const input = createInputState()
    expect(input.assistPlayerPressed).toBe(false)
    expect(input.assistPlayerRisingEdge).toBe(false)
  })

  it('GIVEN KeyZ keydown (first press) WHEN dispatched THEN assistPlayerPressed=true and risingEdge=true', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget)

    keyTarget.emit('keydown', 'KeyZ')

    expect(input.assistPlayerPressed).toBe(true)
    expect(input.assistPlayerRisingEdge).toBe(true)
  })

  it('GIVEN KeyZ held (repeat=true) WHEN keydown dispatched THEN risingEdge remains false (AC6)', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget)

    // First press
    keyTarget.emit('keydown', 'KeyZ', false)
    // Consume latch (simulate mapInputToCommands)
    input.assistPlayerRisingEdge = false

    // Repeat keydown — should NOT set risingEdge
    keyTarget.emit('keydown', 'KeyZ', true)

    expect(input.assistPlayerRisingEdge).toBe(false)
    expect(input.assistPlayerPressed).toBe(true)
  })

  it('GIVEN KeyZ pressed WHEN keyup THEN assistPlayerPressed is cleared (AC6)', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget)

    keyTarget.emit('keydown', 'KeyZ')
    expect(input.assistPlayerPressed).toBe(true)

    keyTarget.emit('keyup', 'KeyZ')
    expect(input.assistPlayerPressed).toBe(false)
  })

  it('GIVEN KeyZ pressed WHEN blur THEN assistPlayerPressed is cleared (AC6)', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const blurTarget = makeBlurTarget()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget, blurTarget)

    keyTarget.emit('keydown', 'KeyZ')
    expect(input.assistPlayerPressed).toBe(true)

    blurTarget.triggerBlur()
    expect(input.assistPlayerPressed).toBe(false)
  })

  it('GIVEN KeyZ pressed WHEN visibilitychange hidden THEN assistPlayerPressed is cleared (AC6)', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const visTarget = makeVisibilityTarget(false)
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget, undefined, visTarget)

    keyTarget.emit('keydown', 'KeyZ')
    expect(input.assistPlayerPressed).toBe(true)

    visTarget.setHidden(true)
    visTarget.triggerChange()
    expect(input.assistPlayerPressed).toBe(false)
  })

  it('GIVEN KeyZ keydown WHEN mapInputToCommands called THEN sample_assist_player command emitted', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget)

    keyTarget.emit('keydown', 'KeyZ')

    const commands = mapInputToCommands(input)
    expect(commands.some((c) => c.type === 'sample_assist_player')).toBe(true)
  })

  it('GIVEN KeyZ keydown WHEN mapInputToCommands called twice THEN second call does NOT emit sample_assist_player (latch consumed)', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget)

    keyTarget.emit('keydown', 'KeyZ')

    // First call consumes the latch
    mapInputToCommands(input)
    // Second call — latch already cleared
    const commands2 = mapInputToCommands(input)
    expect(commands2.some((c) => c.type === 'sample_assist_player')).toBe(false)
  })

  it('GIVEN KeyZ pressed then released then pressed again WHEN mapInputToCommands THEN second press emits another sample_assist_player', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget)

    // First press
    keyTarget.emit('keydown', 'KeyZ', false)
    const c1 = mapInputToCommands(input)
    expect(c1.some((c) => c.type === 'sample_assist_player')).toBe(true)

    // Release
    keyTarget.emit('keyup', 'KeyZ')

    // Second press
    keyTarget.emit('keydown', 'KeyZ', false)
    const c2 = mapInputToCommands(input)
    expect(c2.some((c) => c.type === 'sample_assist_player')).toBe(true)
  })

  it('GIVEN visibilitychange NOT hidden WHEN triggered THEN assistPlayerPressed NOT cleared', () => {
    const canvas = makeFakeCanvas()
    const keyTarget = makeKeyTarget()
    const visTarget = makeVisibilityTarget(false)
    const input = createInputState()
    bindInput(canvas, input, () => ({ width: 960, height: 540 }), keyTarget, undefined, visTarget)

    keyTarget.emit('keydown', 'KeyZ')
    expect(input.assistPlayerPressed).toBe(true)

    // visibility stays visible
    visTarget.setHidden(false)
    visTarget.triggerChange()
    expect(input.assistPlayerPressed).toBe(true)
  })

  it('GIVEN KeyZ bound THEN ASSIST_PLAYER_KEY_CODE equals KeyZ (AC5 contract)', () => {
    expect(ASSIST_PLAYER_KEY_CODE).toBe('KeyZ')
  })
})
