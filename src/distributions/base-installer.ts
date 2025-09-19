import * as tc from '@actions/tool-cache';
import * as core from '@actions/core';
import * as fs from 'fs';
import semver from 'semver';
import path from 'path';
import * as httpm from '@actions/http-client';
import {getToolcachePath, isVersionSatisfies} from '../util';
import {
  JavaDownloadRelease,
  JavaInstallerOptions,
  JavaInstallerResults
} from './base-models';
import {MACOS_JAVA_CONTENT_POSTFIX} from '../constants';
import os from 'os';

export abstract class JavaBase {
  protected http: httpm.HttpClient;
  protected version: string;
  protected architecture: string;
  protected packageType: string;
  protected stable: boolean;
  protected checkLatest: boolean;

  constructor(
    protected distribution: string,
    installerOptions: JavaInstallerOptions
  ) {
    this.http = new httpm.HttpClient('actions/setup-java', undefined, {
      allowRetries: true,
      maxRetries: 3
    });

    ({version: this.version, stable: this.stable} = this.normalizeVersion(
      installerOptions.version
    ));
    this.architecture = installerOptions.architecture || os.arch();
    this.packageType = installerOptions.packageType;
    this.checkLatest = installerOptions.checkLatest;
  }

  protected abstract downloadTool(
    javaRelease: JavaDownloadRelease
  ): Promise<JavaInstallerResults>;
  protected abstract findPackageForDownload(
    range: string
  ): Promise<JavaDownloadRelease>;

  public async setupJava(): Promise<JavaInstallerResults> {
    let foundJava = this.findInToolcache();
    if (foundJava && !this.checkLatest) {
      core.info(`Resolved Java ${foundJava.version} from tool-cache`);
    } else {
      core.info('Trying to resolve the latest version from remote');
      try {
        const javaRelease = await this.findPackageForDownload(this.version);
        core.info(`Resolved latest version as ${javaRelease.version}`);
        if (foundJava?.version === javaRelease.version) {
          core.info(`Resolved Java ${foundJava.version} from tool-cache`);
        } else {
          core.info('Trying to download...');
          foundJava = await this.downloadTool(javaRelease);
          core.info(`Java ${foundJava.version} was downloaded`);
        }
      } catch (error: any) {
        const allProperties = Object.getOwnPropertyNames(error);
        core.info(`All error properties: ${allProperties.join(', ')}`);
        if (error instanceof tc.HTTPError) {
          if (error.httpStatusCode === 403) {
            core.error('HTTP 403: Permission denied or access restricted.');
          } else if (error.httpStatusCode === 429) {
            core.warning('HTTP 429: Rate limit exceeded. Please retry later.');
          } else {
            core.error(`HTTP ${error.httpStatusCode}: ${error.message}`);
          }
        } else {
          const message =
            error instanceof Error ? error.message : JSON.stringify(error);
          core.error(
            `Java setup failed due to network issue or timeout: ${message}`
          );
          // Log specific error details
          const errorMessage = error.message || 'No error message available';
          const errorCode = error.code || 'No error code available';
          const errorStack = error.stack || 'No stack trace available';

          core.error(`Error message: ${errorMessage}`);
          core.error(`Error code: ${errorCode}`);
          core.error(`Stack trace: ${errorStack}`);
          // Check for network-related errors and log endpoint/IP if available
          if (errorCode === 'EACCES') {
            core.error(
              'Permission denied. Check your network or file access permissions.'
            );
          } else if (errorCode === 'ETIMEDOUT') {
            core.error(
              'Connection timed out. Check the endpoint or network stability.'
            );
          }

          // Attempt to log endpoint/IP if present in the error object
          if (error.address || error.port) {
            core.error(
              `Failed to connect to endpoint: ${error.address}:${error.port}`
            );
          }
          // Handle the `errors` property if it exists
          if (Array.isArray(error.errors)) {
            core.error('The error contains multiple sub-errors:');
            error.errors.forEach((subError: any, index: number) => {
              const subErrorMessage =
                subError.message || 'No sub-error message available';
              const subErrorCode =
                subError.code || 'No sub-error code available';
              const subErrorStack =
                subError.stack || 'No sub-error stack trace available';

              core.error(`Sub-error ${index + 1}:`);
              core.error(`  Message: ${subErrorMessage}`);
              core.error(`  Code: ${subErrorCode}`);
              core.error(`  Stack: ${subErrorStack}`);

              // Log endpoint/IP for sub-errors if available
              if (subError.address || subError.port) {
                core.error(`  Endpoint: ${subError.address}:${subError.port}`);
              }
            });
          }
        }
        if (error instanceof Error && error.stack) {
          core.debug(error.stack);
        }
        throw error;
      }
    }

    // JDK folder may contain postfix "Contents/Home" on macOS
    const macOSPostfixPath = path.join(
      foundJava.path,
      MACOS_JAVA_CONTENT_POSTFIX
    );
    if (process.platform === 'darwin' && fs.existsSync(macOSPostfixPath)) {
      foundJava.path = macOSPostfixPath;
    }

    core.info(`Setting Java ${foundJava.version} as the default`);
    this.setJavaDefault(foundJava.version, foundJava.path);

    return foundJava;
  }

  protected get toolcacheFolderName(): string {
    return `Java_${this.distribution}_${this.packageType}`;
  }

  protected getToolcacheVersionName(version: string): string {
    if (!this.stable) {
      if (version.includes('+')) {
        return version.replace('+', '-ea.');
      } else {
        return `${version}-ea`;
      }
    }

    // Kotlin and some Java dependencies don't work properly when Java path contains "+" sign
    // so replace "/hostedtoolcache/Java/11.0.3+4/x64" to "/hostedtoolcache/Java/11.0.3-4/x64" when saves to cache
    // related issue: https://github.com/actions/virtual-environments/issues/3014
    return version.replace('+', '-');
  }

  protected findInToolcache(): JavaInstallerResults | null {
    // we can't use tc.find directly because firstly, we need to filter versions by stability flag
    // if *-ea is provided, take only ea versions from toolcache, otherwise - only stable versions
    const availableVersions = tc
      .findAllVersions(this.toolcacheFolderName, this.architecture)
      .map(item => {
        return {
          version: item
            .replace('-ea.', '+')
            .replace(/-ea$/, '')
            // Kotlin and some Java dependencies don't work properly when Java path contains "+" sign
            // so replace "/hostedtoolcache/Java/11.0.3-4/x64" to "/hostedtoolcache/Java/11.0.3+4/x64" when retrieves  to cache
            // related issue: https://github.com/actions/virtual-environments/issues/3014
            .replace('-', '+'),
          path:
            getToolcachePath(
              this.toolcacheFolderName,
              item,
              this.architecture
            ) || '',
          stable: !item.includes('-ea')
        };
      })
      .filter(item => item.stable === this.stable);

    const satisfiedVersions = availableVersions
      .filter(item => isVersionSatisfies(this.version, item.version))
      .filter(item => item.path)
      .sort((a, b) => {
        return -semver.compareBuild(a.version, b.version);
      });
    if (!satisfiedVersions || satisfiedVersions.length === 0) {
      return null;
    }

    return {
      version: satisfiedVersions[0].version,
      path: satisfiedVersions[0].path
    };
  }

  protected normalizeVersion(version: string) {
    let stable = true;

    if (version.endsWith('-ea')) {
      version = version.replace(/-ea$/, '');
      stable = false;
    } else if (version.includes('-ea.')) {
      // transform '11.0.3-ea.2' -> '11.0.3+2'
      version = version.replace('-ea.', '+');
      stable = false;
    }

    if (!semver.validRange(version)) {
      throw new Error(
        `The string '${version}' is not valid SemVer notation for a Java version. Please check README file for code snippets and more detailed information`
      );
    }

    return {
      version,
      stable
    };
  }

  protected setJavaDefault(version: string, toolPath: string) {
    const majorVersion = version.split('.')[0];
    core.exportVariable('JAVA_HOME', toolPath);
    core.addPath(path.join(toolPath, 'bin'));
    core.setOutput('distribution', this.distribution);
    core.setOutput('path', toolPath);
    core.setOutput('version', version);
    core.exportVariable(
      `JAVA_HOME_${majorVersion}_${this.architecture.toUpperCase()}`,
      toolPath
    );
  }

  protected distributionArchitecture(): string {
    // default mappings of config architectures to distribution architectures
    // override if a distribution uses any different names; see liberica for an example

    // node's os.arch() - which this defaults to - can return any of:
    // 'arm', 'arm64', 'ia32', 'mips', 'mipsel', 'ppc', 'ppc64', 's390', 's390x', and 'x64'
    // so we need to map these to java distribution architectures
    // 'amd64' is included here too b/c it's a common alias for 'x64' people might use explicitly
    switch (this.architecture) {
      case 'amd64':
        return 'x64';
      case 'ia32':
        return 'x86';
      case 'arm64':
        return 'aarch64';
      default:
        return this.architecture;
    }
  }
}
