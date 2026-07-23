# Third-party components

## sigrok-firmware-fx2lafw (bundled firmware)

The `.fw` files under `src/firmware/` are prebuilt firmware images from the
**sigrok-firmware-fx2lafw** project, version **0.1.7**, taken from the official
binary release (https://sigrok.org/download/binary/sigrok-firmware-fx2lafw/).

**License:** the firmware as a whole is licensed under the **GNU GPL, version 2
or later** (some helper files are LGPL v2.1+). Full texts:

- `fx2lafw-COPYING-GPLv2.txt` (GPL v2)
- `fx2lafw-COPYING.LESSER-LGPLv2.1.txt` (LGPL v2.1)

**Corresponding source (GPLv2 §3):** the complete source for these exact binaries
is the upstream 0.1.7 source release:

- <https://sigrok.org/download/source/sigrok-firmware-fx2lafw/sigrok-firmware-fx2lafw-0.1.7.tar.gz>
- Project / repository: <https://sigrok.org/wiki/Fx2lafw>, `git://sigrok.org/sigrok-firmware-fx2lafw`

Written offer: the maintainers of this project will, on request, provide the
complete corresponding source for the bundled firmware version above (identical
to the upstream tarball named). Open an issue on this project to request it.

These firmware images are **separate programs** that execute on the FX2 chip.
This application ships them unmodified as data and uploads them to the device;
it does not link against or incorporate them into its own code. This is "mere
aggregation" under the GPL and does not place this application under the GPL.
