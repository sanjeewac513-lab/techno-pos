TECHNO POS  -  Android app project
===================================

This builds a real APK (installable file) of Techno POS. The app is fully offline and
does not even request internet permission.

EASIEST WAY - build the APK free on GitHub (no software to install)
1. Create a free account at github.com and make a NEW repository (private is fine).
2. Click "uploading an existing file" and upload EVERYTHING inside this folder
   (including the hidden .github folder - on a computer, drag the whole folder contents in).
3. Open the repository > Actions tab > "Build Techno POS APK" > Run workflow
   (it also runs automatically on upload). Wait about 3-5 minutes.
4. Open the finished run > Artifacts > download "TechnoPOS-apk" > unzip > app-debug.apk
5. Copy app-debug.apk to the phone and open it. Android will ask you to allow
   "Install unknown apps" for your file manager/browser - allow it, then install.

OR build it yourself with Android Studio: File > Open this folder > Build > Build APK(s).

NOTES
- Printing uses Android's normal print dialog. For a Bluetooth/USB receipt printer, install
  that printer's Android print plugin/app, then choose it (and the roll paper size) when printing.
- Backups and CSV exports are saved into the phone's Downloads folder.
- This project could not be compiled in the environment it was written in, so the first build
  is untested. The app itself (everything inside app/src/main/assets/www) was tested in a browser.
