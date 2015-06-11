import { exec } from 'teen_process';
import path from 'path';
import log from '../logger.js';
import { tempDir, system, util } from 'appium-support';
import AdmZip from 'adm-zip';
import { getJavaForOs } from '../helpers.js';
import { mkdirp, mv, rimraf } from '../utils.js';

let apkSigningMethods = {};
const java = getJavaForOs();

apkSigningMethods.signWithDefaultCert = async function (apk) {
  let signPath = path.resolve(this.helperJarPath, 'sign.jar');
  log.debug("Resigning apk.");
  try {
    if (!(await util.fileExists(apk))) {
      throw new Error(`${apk} file doesn't exist.`);
    }
    await exec(java, ['-jar', signPath, apk, '--override']);
  } catch (e) {
    log.errorAndThrow(`Could not sign with default ceritficate. Original error ${e.message}`);
  }
};

apkSigningMethods.signWithCustomCert = async function (apk) {
  let jarsigner = path.resolve(process.env.JAVA_HOME, 'bin', 'jarsigner');
  if (system.isWindows()) {
    jarsigner = jarsigner + '.exe';
  }
  if (!(await util.fileExists(this.keystorePath))) {
    throw new Error(`Keystore: ${this.keystorePath} doesn't exist.`);
  }
  if (!(await util.fileExists(apk))) {
    throw new Error(`${apk} file doesn't exist.`);
  }
  try {
    log.debug("Unsigning apk.");
    await exec(java, ['-jar', path.resolve(this.helperJarPath, 'unsign.jar'), apk]);
    log.debug("Signing apk.");
    await exec(jarsigner, ['-sigalg', 'MD5withRSA', '-digestalg', 'SHA1',
                           '-keystore', this.keystorePath, '-storepass', this.keystorePassword,
                           '-keypass', this.keyPassword, apk, this.keyAlias]);
  } catch (e) {
    log.errorAndThrow(`Could not sign with custom ceritficate. Original error ${e.message}`);
  }
};

apkSigningMethods.sign = async function (apk) {
  if (this.useKeystore) {
    await this.signWithCustomCert(apk);
  } else {
    await this.signWithDefaultCert(apk);
  }
  await this.zipAlignApk(apk);
};

apkSigningMethods.zipAlignApk = async function (apk) {
  log.debug("Zip-aligning " + apk);
  await this.initZipAlign();
  let alignedApk = tempDir.path({prefix: 'appium', suffix: '.tmp'});
  await mkdirp(path.dirname(alignedApk));
  log.debug("Zip-aligning apk.");
  try {
    await exec(this.binaries.zipalign, ['-f', '4', apk, alignedApk]);
    await mv(alignedApk, apk, { mkdirp: true });
  } catch (e) {
    log.errorAndThrow(`zipAlignApk failed. Original error: ${e.message}`);
  }
};

// returns true when already signed, false otherwise.
apkSigningMethods.checkApkCert = async function (apk, pkg) {
  if (!(await util.fileExists(apk))) {
    log.debug(`APK doesn't exist. ${apk}`);
    return false;
  }
  if (this.useKeystore) {
    return this.checkCustomApkCert(apk, pkg);
  }
  log.debug(`Checking app cert for ${apk}.`);
  try {
    await exec(java, ['-jar', path.resolve(this.helperJarPath, 'verify.jar'), apk]);
    log.debug("App already signed.");
    await this.zipAlignApk(apk);
    return true;
  } catch (e) {
    log.debug("App not signed with debug cert.");
    return false;
  }
};

apkSigningMethods.checkCustomApkCert = async function (apk, pkg) {
  let h = "a-fA-F0-9";
  let md5Str = ['.*MD5.*((?:[', h, ']{2}:){15}[', h, ']{2})'].join('');
  let md5 = new RegExp(md5Str, 'mi');
  if (!process.env.JAVA_HOME) {
    throw new Error("JAVA_HOME is not set");
  }
  let keytool = path.resolve(process.env.JAVA_HOME, 'bin', 'keytool');
  keytool = system.isWindows() ? keytool + '.exe' : keytool;
  let keystoreHash = await this.getKeystoreMd5(keytool, md5);
  return await this.checkApkKeystoreMatch(keytool, md5, keystoreHash, pkg, apk);
};

apkSigningMethods.getKeystoreMd5 = async function (keytool, md5re) {
  let keystoreHash;
  log.debug("Printing keystore md5.");
  try {
    let {stdout} = await exec(keytool, ['-v', '-list', '-alias', this.keyAlias,
                        '-keystore', this.keystorePath, '-storepass',
                         this.keystorePassword]);
    keystoreHash = md5re.exec(stdout);
    keystoreHash = keystoreHash ? keystoreHash[1] : null;
    log.debug(`Keystore MD5: ${keystoreHash}`);
    return keystoreHash;
  } catch (e) {
    log.errorAndThrow(`getKeystoreMd5 failed. Original error: ${e.message}`);
  }
};

apkSigningMethods.checkApkKeystoreMatch = async function (keytool, md5re, keystoreHash,
    pkg, apk) {
  let entryHash = null;
  let zip = new AdmZip(apk);
  let rsa = /^META-INF\/.*\.[rR][sS][aA]$/;
  let entries = zip.getEntries();

  for (let entry of entries) {
    entry = entry.entryName;
    if (!rsa.test(entry)) {
      continue;
    }
    log.debug(`Entry: ${entry}`);
    let entryPath = path.join(this.tmpDir, pkg, 'cert');
    log.debug(`entryPath: ${entryPath}`);
    let entryFile = path.join(entryPath, entry);
    log.debug(`entryFile: ${entryFile}`);
    // ensure /tmp/pkg/cert/ doesn't exist or extract will fail.
    await rimraf(entryPath);
    // META-INF/CERT.RSA
    zip.extractEntryTo(entry, entryPath, true); // overwrite = true
    log.debug("extracted!");
    // check for match
    log.debug("Printing apk md5.");
    let {stdout} = await exec(keytool, ['-v', '-printcert', '-file', entryFile]);
    entryHash = md5re.exec(stdout);
    entryHash = entryHash ? entryHash[1] : null;
    log.debug(`entryHash MD5: ${entryHash}`);
    log.debug(`keystore MD5: ${keystoreHash}`);
    let matchesKeystore = entryHash && entryHash === keystoreHash;
    log.debug(`Matches keystore? ${matchesKeystore}`);
    if (matchesKeystore) {
      return true;
    }
  }
  return false;
};

export default apkSigningMethods;