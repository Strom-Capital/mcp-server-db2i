/**
 * Narrated videos in a light and a dark version: `figure[data-video]` with one <video> per
 * theme (SiteVideo.astro, or the same markup in a blog post). Switching the theme mid-play
 * hands playback over to the other version at the same second.
 */
for (const figure of document.querySelectorAll<HTMLElement>('figure[data-video]')) {
  const videos = [...figure.querySelectorAll('video')];

  // Hand a started video over to the version for the new theme.
  const sync = () => {
    const target = videos.find((v) => v.checkVisibility());
    for (const video of videos) {
      if (video === target || (video.paused && video.currentTime === 0)) continue;
      const playing = !video.paused;
      video.pause();
      if (!target) continue;
      target.currentTime = video.currentTime;
      target.muted = video.muted;
      target.volume = video.volume;
      if (video.textTracks[0] && target.textTracks[0]) target.textTracks[0].mode = video.textTracks[0].mode;
      if (playing) target.play().catch(() => {});
    }
  };
  document.addEventListener('themechange', sync);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);

  // One analytics event per video per page view, see Analytics.astro.
  let tracked = false;
  for (const video of videos) {
    video.addEventListener('play', () => {
      if (tracked) return;
      tracked = true;
      (window as { posthog?: { capture: (event: string, props?: object) => void } }).posthog?.capture('promo_video_played', {
        video: figure.dataset.video,
        theme: video.dataset.themeVersion,
      });
    });
  }
}
