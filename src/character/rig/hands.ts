/**
 * Cartoon glove shapes. Local frame: wrist at the origin, +y runs from the wrist toward the
 * fingertips, +x is the thumb side of her left hand (screen right). The screen-left hand is the
 * same drawing mirrored. Each shape is a palm blob plus finger strokes, drawn in two passes
 * (dark silhouette, then cream fill) so touching parts merge under one clean outline.
 * Sizes follow the GIF fist: 28 x 37 units including the outline.
 */
export type HandShape = 'fist' | 'open' | 'palmUp' | 'point' | 'knock' | 'clap' | 'chin';

export const HAND_SHAPES: readonly HandShape[] = ['fist', 'open', 'palmUp', 'point', 'knock', 'clap', 'chin'];

export interface HandArt {
  palm: string;
  fingers: readonly { d: string; w: number }[];
  creases: string;
}

export const HANDS: Record<HandShape, HandArt> = {
  // Relaxed hanging fist seen from the outside (giphy.gif): thumb crease outside, curled fingers inside.
  fist: {
    palm: 'M -8.4 -1.5 C -9.4 3.5 -13.6 7.4 -13.8 15.2 C -14 25.4 -8.8 34.2 0.6 34.8 C 9 35.3 14.6 29.6 14.6 21.2 C 14.6 13.6 11.6 7.6 9.2 4.6 C 8.6 2.6 8.4 0.6 8.4 -1.5 Z',
    fingers: [],
    creases:
      'M 9.6 8.6 C 12.2 12.6 12.6 17.6 10.4 22.2 ' +
      'M -13.6 17.4 C -9.8 17.6 -7.2 19.8 -6.8 23.4 ' +
      'M -12 26.4 C -8.4 26.6 -5.8 28.8 -5.4 32.2',
  },
  // "HEY Y'ALL!" open palm: four fingers fanned, thumb out toward the body.
  open: {
    palm: 'M -8.6 -1.5 C -10.4 4.6 -12.2 10.2 -11.8 16 C -11.4 20.6 -8.4 23.6 -4.6 24 L 5 24 C 9 23.6 11.8 20.6 12.2 16 C 12.6 10.2 10.6 4.6 8.6 -1.5 Z',
    fingers: [
      { d: 'M 6.6 18.6 L 9.6 33.2', w: 6.1 },
      { d: 'M 2.2 19.4 L 3.2 36.4', w: 6.3 },
      { d: 'M -2.4 19.4 L -3.4 35', w: 6.1 },
      { d: 'M -6.8 18 L -9.8 30', w: 5.6 },
      { d: 'M 8.4 8.4 L 17.6 15.6', w: 6.2 },
    ],
    creases: 'M -1.6 13.8 C 0.6 15.4 3 15.6 5.2 14.4',
  },
  // Cutout shrug: palm up, fingers relaxed and curling, thumb raised.
  palmUp: {
    palm: 'M -8.4 -1.5 C -11.2 5.6 -11.6 13.6 -8.6 19.6 C -5.6 24.4 5.4 24.6 9.2 20 C 12.4 15.6 11.6 6 8.4 -1.5 Z',
    fingers: [
      { d: 'M 6.2 18.2 Q 8.4 26.4 12.6 30.2', w: 5.8 },
      { d: 'M 2 19.4 Q 3.2 28.6 6.8 33.6', w: 6 },
      { d: 'M -2.2 19.2 Q -2.4 28 0.4 32.6', w: 5.8 },
      { d: 'M -6.2 17.4 Q -7.6 24.6 -5.6 29', w: 5.4 },
      { d: 'M 7.8 5.6 Q 14.6 5.4 17.6 0.4', w: 6 },
    ],
    creases: 'M -5.4 11.6 C -1.4 14.6 3.8 14.8 7.4 12.2',
  },
  // "Now listen here": index finger straight up, thumb wrapped over the curled fingers.
  point: {
    palm: 'M -8.4 -1.5 C -9.8 4.4 -13 8.4 -12.8 15.6 C -12.6 23.2 -8.2 28.2 -1.4 28.4 C 5.6 28.6 11.8 25.4 12.6 18.8 C 13.4 12.2 10.8 6.6 8.6 3.4 C 8.4 1.6 8.4 0 8.4 -1.5 Z',
    fingers: [
      { d: 'M 6.4 20.8 L 7.2 41.4', w: 6.3 },
    ],
    creases:
      'M 10.6 9.6 C 7.6 13.8 3.2 16.4 -2.2 17 ' +
      'M -12.4 19.6 C -8.8 20 -6.6 22.4 -6.4 25.6 ' +
      'M -6.4 25.6 C -4 24.8 -1.6 25.4 -0.2 27.6',
  },
  // Fist seen knuckles-first for knocking on the screen glass.
  knock: {
    palm: 'M -13.4 1.2 C -15.8 8.6 -15.6 22.6 -11.2 29.4 C -6.4 34.8 6.8 35 11.6 29.6 C 16 23 16.2 9 13.6 1.4 C 9.4 -2.2 -9.2 -2.2 -13.4 1.2 Z',
    fingers: [],
    creases:
      'M -6.8 31.6 L -7.2 18.6 M 0 33.4 L 0 18.8 M 6.8 31.8 L 7.2 18.6 ' +
      'M -12.6 14 C -5.2 19.2 4.4 19.2 12.2 13.4',
  },
  // Edge-on flat hand for clapping: fingers together, thumb along the side.
  clap: {
    palm: 'M -6.6 -1.5 C -8.4 7.6 -8.6 21.4 -6.8 31.4 C -5.6 38.4 4.2 39.2 5.8 32.6 C 7.4 23.8 7.6 9.6 6.6 -1.5 Z',
    fingers: [
      { d: 'M 4.4 7.4 Q 10.6 11 10.8 19.4', w: 5.6 },
    ],
    creases: 'M -2.2 16 C -1.8 22 -1.6 27.4 -2.4 32.6',
  },
  // Thinking: fist with the index finger curled up toward the chin.
  chin: {
    palm: 'M -8.4 -1.5 C -9.8 4.4 -13 8.4 -12.8 15.6 C -12.6 23.2 -8.2 28.2 -1.4 28.4 C 5.6 28.6 11.8 25.4 12.6 18.8 C 13.4 12.2 10.8 6.6 8.6 3.4 C 8.4 1.6 8.4 0 8.4 -1.5 Z',
    fingers: [
      { d: 'M 6.2 21 Q 8.4 31.6 2.2 37.4', w: 6.2 },
    ],
    creases:
      'M 10.6 9.6 C 7.6 13.8 3.2 16.4 -2.2 17 ' +
      'M -12.4 19.6 C -8.8 20 -6.6 22.4 -6.4 25.6',
  },
};

/** Approximate reach of each shape from the wrist (for bounds). */
export const HAND_REACH: Record<HandShape, number> = {
  fist: 36, open: 38, palmUp: 35, point: 44, knock: 36, clap: 40, chin: 40,
};
