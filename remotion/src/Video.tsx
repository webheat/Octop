import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { SCENE_COMPONENTS } from "./scenes";
import { resolveTheme, sceneDuration, type BgmSpec, type VideoScript } from "./types";

export interface VideoProps {
  script: VideoScript;
}

/** Small lead-in so a line starts just after the cut, not exactly on it. */
const VOICE_LEAD_SECONDS = 0.12;

const clampGain = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Gain curve for the music bed: fade in, fade out, and duck under narration.
 *
 * `frame` is absolute (the audio sits at the composition root), so the tail
 * fade can be measured against the real total length.
 */
function makeBgmVolume(
  bgm: BgmSpec,
  fps: number,
  totalFrames: number,
  voicedRanges: Array<[number, number]>,
): (frame: number) => number {
  const base = bgm.volume ?? 0.3;
  const fadeInFrames = Math.max(1, Math.round((bgm.fadeIn ?? 0.8) * fps));
  const fadeOutFrames = Math.max(1, Math.round((bgm.fadeOut ?? 1.2) * fps));
  const duck = bgm.duck ?? 0.6;

  return (frame: number) => {
    let gain = base;
    if (frame < fadeInFrames) gain *= frame / fadeInFrames;
    const tail = totalFrames - frame;
    if (tail < fadeOutFrames) gain *= Math.max(0, tail / fadeOutFrames);
    if (voicedRanges.some(([start, end]) => frame >= start && frame < end)) {
      gain *= duck;
    }
    return clampGain(gain);
  };
}

/**
 * Renders a script scene by scene.
 *
 * Each scene is placed on its own `<Sequence>`, so scene timing lives in the
 * script rather than in the component tree. Audio is layered the same way: the
 * music bed spans the whole composition, while each narration clip is mounted
 * inside its scene's sequence so it can never outlive the picture.
 */
export const Video: React.FC<VideoProps> = ({ script }) => {
  const theme = resolveTheme(script);
  const fps = script.fps ?? 30;
  const scenes = script.scenes ?? [];

  let cursor = 0;
  const placed = scenes.map((scene) => {
    const durationInFrames = Math.max(1, Math.round(sceneDuration(scene) * fps));
    const start = cursor;
    cursor += durationInFrames;
    return { scene, durationInFrames, start };
  });
  const totalFrames = Math.max(1, cursor);

  const bgm = script.audio?.bgm;
  const voicedRanges = placed
    .filter((item) => Boolean(item.scene.audio?.src))
    .map((item): [number, number] => [item.start, item.start + item.durationInFrames]);

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {bgm?.src ? (
        <Audio
          src={staticFile(bgm.src)}
          startFrom={Math.max(0, Math.round((bgm.offset ?? 0) * fps))}
          loop={bgm.loop ?? false}
          volume={makeBgmVolume(bgm, fps, totalFrames, voicedRanges)}
        />
      ) : null}
      {placed.map(({ scene, durationInFrames, start }) => {
        const key = scene.id ?? `${scene.type}-${start}`;
        const Component = SCENE_COMPONENTS[scene.type] ?? SCENE_COMPONENTS.text;
        const clip = scene.audio?.src;
        return (
          <Sequence key={key} from={start} durationInFrames={durationInFrames} name={key}>
            <Component scene={scene} script={script} />
            {clip ? (
              <Sequence
                from={Math.round(VOICE_LEAD_SECONDS * fps)}
                name={`${key} · voice`}
              >
                <Audio src={staticFile(clip)} volume={scene.audio?.volume ?? 1} />
              </Sequence>
            ) : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
