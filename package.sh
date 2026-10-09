#!/bin/bash

# package TiddlyDesktop into zip files

# run this after bld.sh

VERSION=$(./bin/get-version-number)

# Zip them up
package_win32() {
pushd ./output/win32
zip -r "../tiddlydesktop-win32-v$VERSION.zip" *
popd
}

package_win64() {
pushd ./output/win64
zip -r "../tiddlydesktop-win64-v$VERSION.zip" *
popd
}

# Sign the app ad-hoc and package it as a zip and as a disk image
# The disk image avoids problems with Archive Utility and Safari's automatic unzipping
package_mac() {
local name="$1"
local folder="TiddlyDesktop-$name-v$VERSION"
pushd "./output/$name"
sudo xattr -rc "./$folder/TiddlyDesktop.app"
sudo codesign --force --deep --sign - "./$folder/TiddlyDesktop.app"
codesign --verify --deep --strict "./$folder/TiddlyDesktop.app" || exit 1
zip --symlinks -r "../tiddlydesktop-$name-v$VERSION.zip" *
# Build the disk image from a folder that only contains the app. The link to /Applications is
# added to the mounted image afterwards, otherwise hdiutil would copy the whole Applications folder
rm -rf dmg-staging dmg-mount dmg-rw.dmg
mkdir dmg-staging dmg-mount
ditto "./$folder/TiddlyDesktop.app" "dmg-staging/TiddlyDesktop.app"
hdiutil create -volname "TiddlyDesktop" -srcfolder dmg-staging -fs HFS+ -format UDRW -ov dmg-rw.dmg || exit 1
hdiutil attach dmg-rw.dmg -nobrowse -noautoopen -mountpoint dmg-mount || exit 1
ln -s /Applications dmg-mount/Applications
hdiutil detach dmg-mount || hdiutil detach -force dmg-mount || exit 1
hdiutil convert dmg-rw.dmg -format UDZO -ov -o "../tiddlydesktop-$name-v$VERSION.dmg" || exit 1
rm -rf dmg-staging dmg-mount dmg-rw.dmg
popd
}

package_mac64() {
package_mac mac64
}

package_macapplesilicon() {
package_mac macapplesilicon
}

package_linux32() {
pushd ./output/linux32
zip -r "../tiddlydesktop-linux32-v$VERSION.zip" *
popd
}

package_linux64() {
pushd ./output/linux64
zip -r "../tiddlydesktop-linux64-v$VERSION.zip" *
popd
}


if [ "$CI" = "true" ]; then
    # Running in GitHub Actions, where each platform builds as a separate step, in parallel, with PLATFORM and ARCH variables supplied by the GitHub Actions script
	case "$PLATFORM-$ARCH" in
		osx-x64)
			package_mac64
			;;
		osx-arm64)
			package_macapplesilicon
			;;
		win-ia32)
			package_win32
			;;
		win-x64)
			package_win64
			;;
		linux-ia32)
			package_linux32
			;;
		linux-x64)
			package_linux64
			;;
	esac
else
    # Running at the command line, where each platfom builds one at a time in sequence
	package_mac64
	package_macapplesilicon
	package_win32
	package_win64
	package_linux32
	package_linux64
fi
