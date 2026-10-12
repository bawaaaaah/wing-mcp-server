// Glyphs drawn for this project, for the WING icons neither Material Design Icons nor
// game-icons.net has: cymbals, hand percussion, harmonica, keytar, subwoofer, wedge, line array,
// column PA and shotgun mic. Same 24×24 grid and filled style as MDI. Original work, MIT-licensed
// like the rest of this repository. `evenodd` marks the ones whose holes (a sound hole, a cone,
// key gaps) are cut out with the even-odd fill rule.

export const CUSTOM_ICONS_VIEWBOX = "0 0 24 24";

export const CUSTOM_ICONS = {
  /** Cymbal on a stand (crash, ride, splash) */
  cymbal: { d: "M2.5 7a9.5 1.9 0 1 0 19 0a9.5 1.9 0 1 0 -19 0ZM10.2 5.2a1.8 1.2 0 1 0 3.6 0a1.8 1.2 0 1 0 -3.6 0ZM11.2 8.5h1.6v9.5h-1.6ZM11.2 17.5L12.8 17.5L17.5 22L15.6 22L12 18.8L8.4 22L6.5 22Z", evenodd: false },
  /** Hi-hat: two cymbals on a stand */
  hiHat: { d: "M3 5a9 1.5 0 1 0 18 0a9 1.5 0 1 0 -18 0ZM10.4 3.6a1.6 1 0 1 0 3.2 0a1.6 1 0 1 0 -3.2 0ZM3 8.2a9 1.5 0 1 0 18 0a9 1.5 0 1 0 -18 0ZM11.2 9.5h1.6v8.5h-1.6ZM11.2 17.5L12.8 17.5L17.5 22L15.6 22L12 18.8L8.4 22L6.5 22Z", evenodd: false },
  /** Cowbell: a flat folded-metal bell with a rectangular mouth and a loop handle */
  cowbell: { d: "M8.4 5.6L15.6 5.6L18.9 18.2L5.1 18.2ZM9.7 6.8L10.3 6.8L8.1 17.4L7.4 17.4ZM13.7 6.8L14.3 6.8L16.6 17.4L15.9 17.4ZM5.2 18.2h13.6a1 1 0 0 1 1 1v1.2a1 1 0 0 1 -1 1h-13.6a1 1 0 0 1 -1 -1v-1.2a1 1 0 0 1 1 -1ZM6.1 19.1h11.8a0.5 0.5 0 0 1 0.5 0.5v0.4a0.5 0.5 0 0 1 -0.5 0.5h-11.8a0.5 0.5 0 0 1 -0.5 -0.5v-0.4a0.5 0.5 0 0 1 0.5 -0.5ZM11.2 2.4h1.6a0.9 0.9 0 0 1 0.9 0.9v1.8a0.9 0.9 0 0 1 -0.9 0.9h-1.6a0.9 0.9 0 0 1 -0.9 -0.9v-1.8a0.9 0.9 0 0 1 0.9 -0.9ZM11.5 3.3h1a0.3 0.3 0 0 1 0.3 0.3v1.3a0.3 0.3 0 0 1 -0.3 0.3h-1a0.3 0.3 0 0 1 -0.3 -0.3v-1.3a0.3 0.3 0 0 1 0.3 -0.3Z", evenodd: true },
  /** Congas: two tall barrel drums */
  congas: { d: "M2.5 4a4 1.1 0 1 0 8 0a4 1.1 0 1 0 -8 0ZM2.5 5.6Q1.6 13 3.7 22H9.3Q11.4 13 10.5 5.6Q6.5 7 2.5 5.6ZM13 2.5a4 1.1 0 1 0 8 0a4 1.1 0 1 0 -8 0ZM13 4.1Q12.1 12.25 14.2 22H19.8Q21.9 12.25 21 4.1Q17 5.5 13 4.1Z", evenodd: false },
  /** Bongos: two small joined drums */
  bongos: { d: "M2 7a4.5 1.1 0 1 0 9 0a4.5 1.1 0 1 0 -9 0ZM2 8.6Q1.6 12.5 3.35 18H9.65Q11.4 12.5 11 8.6Q6.5 10 2 8.6ZM13.5 8a3.75 1.1 0 1 0 7.5 0a3.75 1.1 0 1 0 -7.5 0ZM13.5 9.6Q13.2 12.5 14.62 17H19.88Q21.3 12.5 21 9.6Q17.25 11 13.5 9.6ZM10.5 11.2h3.5v1.8h-3.5Z", evenodd: false },
  /** Timbales: two shallow drums on a stand */
  timbales: { d: "M2 4a4.5 1.1 0 1 0 9 0a4.5 1.1 0 1 0 -9 0ZM2.8 5.4h7.4a0.8 0.8 0 0 1 0.8 0.8v1.4a0.8 0.8 0 0 1 -0.8 0.8h-7.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.4a0.8 0.8 0 0 1 0.8 -0.8ZM13 4.6a4.5 1.1 0 1 0 9 0a4.5 1.1 0 1 0 -9 0ZM13.8 6h7.4a0.8 0.8 0 0 1 0.8 0.8v1.4a0.8 0.8 0 0 1 -0.8 0.8h-7.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.4a0.8 0.8 0 0 1 0.8 -0.8ZM5.8 8.6h12.4v1.4h-12.4ZM11.2 9.5h1.6v8.5h-1.6ZM11.2 17.5L12.8 17.5L17.5 22L15.6 22L12 18.8L8.4 22L6.5 22Z", evenodd: false },
  /** Cajón in three-quarter view: front, side and the sound hole on the side */
  cajon: { d: "M4 3.2L14.5 3.2L19.4 1.6L9 1.6ZM4 4L14.5 4L14.5 21.5L4 21.5ZM15.3 4L20 2.4L20 19.6L15.3 21.5ZM16.3 8.4a1.4 1.9 0 1 0 2.8 0a1.4 1.9 0 1 0 -2.8 0Z", evenodd: true },
  /** Harmonica */
  harmonica: { d: "M3.4 8.5h17.2a1.4 1.4 0 0 1 1.4 1.4v4.2a1.4 1.4 0 0 1 -1.4 1.4h-17.2a1.4 1.4 0 0 1 -1.4 -1.4v-4.2a1.4 1.4 0 0 1 1.4 -1.4ZM4 11h1.3v2h-1.3ZM6.25 11h1.3v2h-1.3ZM8.5 11h1.3v2h-1.3ZM10.75 11h1.3v2h-1.3ZM13 11h1.3v2h-1.3ZM15.25 11h1.3v2h-1.3ZM17.5 11h1.3v2h-1.3Z", evenodd: true },
  /** Keytar */
  keytar: { d: "M3.11 14.46L16.36 7.42L19.18 12.71L5.93 19.76ZM16.67 9.06L21.08 6.72L22.21 8.84L17.8 11.18ZM5.57 16.1L6.54 15.58L7.95 18.23L6.98 18.75ZM7.25 15.21L8.22 14.69L9.63 17.34L8.66 17.85ZM8.93 14.31L9.9 13.8L11.31 16.45L10.33 16.96ZM10.6 13.42L11.58 12.91L12.98 15.55L12.01 16.07ZM12.28 12.53L13.25 12.01L14.66 14.66L13.69 15.18ZM13.96 11.64L14.93 11.12L16.34 13.77L15.37 14.29Z", evenodd: true },
  /** Subwoofer: a box with a large cone */
  subwoofer: { d: "M5.6 2.5h12.8a1.6 1.6 0 0 1 1.6 1.6v15.8a1.6 1.6 0 0 1 -1.6 1.6h-12.8a1.6 1.6 0 0 1 -1.6 -1.6v-15.8a1.6 1.6 0 0 1 1.6 -1.6ZM5.8 12a6.2 6.2 0 1 0 12.4 0a6.2 6.2 0 1 0 -12.4 0ZM9.6 12a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0Z", evenodd: true },
  /** Stage wedge (floor monitor), side view */
  wedge: { d: "M2 20L22 20L22 15.5L8.5 7L2 9ZM11.04 10.67a4.2 1.9 32 1 0 7.12 4.45a4.2 1.9 32 1 0 -7.12 -4.45Z", evenodd: true },
  /** Line array, side view: trapezoid cabinets hinged at the front, curving into a J under a fly frame */
  lineArray: { d: "M3 2.4L15.4 2.4L15.4 3.5L3 3.5ZM8.6 2.4L9.6 0.6L10.6 2.4ZM3.4 4.6L14.9 5.4L14.9 7.1L3.4 7.9ZM4.3 4.95L5 5L5 7.5L4.3 7.55ZM3.4 8.35L14.92 8.75L14.98 10.45L3.52 11.65ZM4.31 8.67L5.01 8.69L5.1 11.19L4.4 11.27ZM3.53 12.1L15.05 11.69L15.23 13.38L3.88 15.38ZM4.46 12.35L5.16 12.33L5.43 14.81L4.73 14.94ZM3.92 15.83L15.34 14.22L15.69 15.88L4.61 19.06ZM4.88 15.98L5.57 15.89L6.09 18.33L5.42 18.53ZM4.7 19.5L15.78 16.31L16.36 17.91L5.83 22.6ZM5.67 19.52L6.34 19.32L7.2 21.67L6.56 21.96Z", evenodd: true },
  /** Column PA on its sub */
  columnPa: { d: "M10.7 2h2.6a1.2 1.2 0 0 1 1.2 1.2v10.6a1.2 1.2 0 0 1 -1.2 1.2h-2.6a1.2 1.2 0 0 1 -1.2 -1.2v-10.6a1.2 1.2 0 0 1 1.2 -1.2ZM10.9 4.4a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0ZM10.9 7.2a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0ZM10.9 10a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0ZM10.9 12.8a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0ZM7.7 16h8.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-8.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2ZM10 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z", evenodd: true },
  /** Shotgun microphone on a pistol grip */
  shotgunMic: { d: "M2.7 7.6h11.6a1.2 1.2 0 0 1 1.2 1.2v0.4a1.2 1.2 0 0 1 -1.2 1.2h-11.6a1.2 1.2 0 0 1 -1.2 -1.2v-0.4a1.2 1.2 0 0 1 1.2 -1.2ZM3.6 8.5h1.3v1h-1.3ZM5.9 8.5h1.3v1h-1.3ZM8.2 8.5h1.3v1h-1.3ZM10.5 8.5h1.3v1h-1.3ZM16 7h4.5a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4.5a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1ZM15.8 11L19.2 11L20.4 19.6L17.2 20.4ZM15 6.1h0.4a0.4 0.4 0 0 1 0.4 0.4v5a0.4 0.4 0 0 1 -0.4 0.4h-0.4a0.4 0.4 0 0 1 -0.4 -0.4v-5a0.4 0.4 0 0 1 0.4 -0.4Z", evenodd: true },
} as const satisfies Record<string, { d: string; evenodd: boolean }>;
