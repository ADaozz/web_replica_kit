# Synthetic video fixture

`video-colors.mp4` is a generated 64×48 H.264 video: red for one second, then blue for one second, at 5 fps. No external content or audio. Tests seek to 1.4 seconds and verify that static export preserves blue rather than reverting to the initial frame. Running tests requires only Playwright Chromium, not ffmpeg.

Recreate the fixture with ffmpeg:

```sh
ffmpeg -f lavfi -i 'color=c=red:s=64x48:r=5:d=1' \
  -f lavfi -i 'color=c=blue:s=64x48:r=5:d=1' \
  -filter_complex '[0:v][1:v]concat=n=2:v=1:a=0[out]' -map '[out]' \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart tests/fixtures/video-colors.mp4
```
