# Paint your own FINSONLY livery

Two files per aircraft, made by `tools/paint_kit.py`:

| Aircraft | Paint on | Reference layer | Export as |
|---|---|---|---|
| F-16 | `f16_kit_blank.webp` (2048 x 2048) | `f16_kit_guides.png` | 2048 x 2048 PNG, WebP or JPEG |
| Boeing 757-200 | `b757_kit_blank.png` (1024 x 1024) | `b757_kit_guides.png` | 1024 x 1024 PNG, WebP or JPEG |

1. Open the blank in any editor that has layers (Photopea in a browser works).
2. Put the guides on top as their own layer. Pink lines outline each part of the jet, with its
   name. Red hatching marks texels nobody sees from outside (cockpit tub, intake duct, wheel
   wells): paint there and it's wasted.
3. Paint on layers between the blank and the guides. Keep the canvas the exact size above.
4. Hide the guides layer, then export.
5. Upload it in the Garage (race.finsonly.net, Garage, Paint your own). You can fly it straight
   away; everyone else sees it once it's approved.

Things that trip people up:

- **Mirrored parts.** Some parts share one patch of texture for both sides, so text on them reads
  backwards on one side. F-16: the fin (both sides), the wing undersides, the leading-edge flaps
  and some fuselage-side strips. 757: the engines, winglets and pylons. Put text on the separate
  left/right fuselage parts instead, or use symbols that look the same mirrored.
- **757 right side is flipped.** The lower fuselage band is the right side, mirrored. Write text
  there backwards (flip the text layer horizontally) so it reads right on the jet.
- **Size cap.** The server re-encodes your file (WebP for the F-16, PNG for the 757) and it must
  end up under 1.5 MB. Fine noise and photo textures blow the cap; flat colours and clean
  gradients don't.
- **Half or double size** (1024 for the F-16, 512 or 2048 for the 757) is accepted and rescaled.
  Anything else is rejected.
- Original art only: no real airline liveries, military markings, national insignia, brands or
  characters. Uploads are checked before anyone else sees them.

The Rafale has no paint kit (its livery is a whole-airframe chrome tint); use the Rafale chrome
template in the Garage instead.
