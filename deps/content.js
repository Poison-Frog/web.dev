/*
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const path = require('path');
const isDir = require('./is-dir.js');
const isGlob = require('is-glob');
const micromatch = require('micromatch');
const yamlPrefix = require('./yaml-prefix.js');
const YAML = require('yaml').default;
const fsp = require('./fsp.js');

const alwaysReadSource = ['.md', '.yaml', '.html'];


class ContentFile {

  /**
   * @param {string} fullPath
   * @param {?Object<string, *>} config
   * @param {(?string|undefined)=} content
   */
  constructor(fullPath, config=null, content=null) {
    this.config = config;
    this.content = content;

    const parsed = path.parse(fullPath);

    /** @public {string} */
    this.ext = parsed.ext;

    /** @public {string} */
    this.dir = parsed.dir;

    /** @public {string} */
    this.base = parsed.base;
  }

  /**
   * @return {?string}
   */
  async read() {
    if (this.content === undefined) {
      if (isDir(this.path) === false) {
        this.content = fsp.readFile(this.path, 'utf8');
      } else {
        // not a real file, don't try to read it
        this.content = null;
      }
    }
    return this.content;
  }

  /**
   * @param {string} fullPath path to a real on-disk source file
   * @return {!ContentFile}
   */
  static async _buildFromSource(fullPath) {
    let content = undefined;
    let config = null;

    const ext = path.extname(fullPath);
    if (alwaysReadSource.includes(ext)) {
      content = await fsp.readFile(fullPath, 'utf8');

      switch (ext) {
        case '.md':
          // read markdown content and remove YAML prefix
          const out = yamlPrefix(content);
          content = out.rest;
          config = out.config;
          break;
        case '.yaml':
          // parse YAML but leave source intact
          config = YAML.parse(content);
          break;
      }
    }

    return new ContentFile(fullPath, config, content);
  }
}


class ContentLoader {

  /**
   * @param {string} dir root dir to process from, used for lang
   */
  constructor(dir) {
    this._dir = dir;

    /**
     * @private {!Array<{dir: string, name: string, gen: *}>}
     */
    this._gen = [];

    /**
     * @private {!Object<string, !ContentFile>}
     */
    this._cache = {};
  }

  /**
   * Registers a virtual path and a matching generator.
   *
   * If the specified name is a glob, then this will only create virtual files when explicitly
   * specified or included as a dependency.
   *   e.g. 'example','_config-*.yaml' will not match for 'example/*', but will for an explicit
   *        path such as 'path/to/_config-foo.yaml'.
   *
   * @param {string} dir glob-style directory to match
   * @param {string} name glob-style filename to match
   * @param {*} gen generator for file
   */
  register(dir, name, gen) {
    this._gen.push({dir, name, gen});
  }

  _virtual(candidateDir, candidateName='*') {
    // TODO(samthor): we recompile/rework the micromatch calls every run, slow.
    const out = this._gen.map(({dir, name, gen}) => {
      // match non-glob candidate against glob stored dir
      // e.g. 'path/foo' against 'path/*'
      if (!micromatch.isMatch(candidateDir, dir)) {
        return null;  // not the right dir
      }

      // match non-glob candidate (specific file request) against glob stored name
      // e.g. '_gen-filename.md' against '_gen-*.md'
      if (micromatch.isMatch(candidateName, name)) {
        return {name: candidateName, gen};
      }

      // match glob candidate (broad request, normal) against non-glob stored name
      // e.g. '*' against anything, or '*.md' against 'foo.md'
      if (!isGlob(name)) {
        if (candidateName === '*' || micromatch.isMatch(name, candidateName)) {
          return {name, gen};
        }
      }

      return null;  // no match
    }).filter((x) => x !== null);

    return out;
  }

  /**
   * @param {string} req specific non-gen path request
   * @return {?ContentFile}
   */
  async get(req) {
    if (isGlob(req)) {
      throw new Error('can\'t glob read()');
    }

    const out = await this.contents(req);
    if (out.length > 1) {
      throw new Error('somehow matched more than one file');
    } else if (out.length === 0) {
      return null;
    }

    // TODO(samthor): probably allows horrible recursive loops
    return out[0];
  }

  /**
   * @param {string} req glob-style path request
   * @param {boolean=} recurse search further dirs
   * @return {!Array<{path: string, gen: *, cf: !ContentFile}>}
   */
  async contents(req, recurse=false) {
    req = path.normalize(req);

    if (isDir(req)) {
      return this._contents(req, '*', recurse);
    }

    const dir = path.dirname(req);
    if (isGlob(dir)) {
      throw new Error('glob parts unsupported in directory, use shell');
    }
    const name = path.basename(req);

    return this._contents(dir, name, recurse);
  }

  async _contents(rootDir, globName, recurse) {
    if (!isDir(rootDir)) {
      return [];  // dir does not exist
    }

    const pendingDir = [rootDir];
    const out = [];

    while (pendingDir.length) {
      const currentDir = pendingDir.shift();
      const dirContent = await fsp.readdir(currentDir);

      const matchedFiles =
          globName === '*' ? dirContent : micromatch.match(dirContent, globName);
      for (const raw of matchedFiles) {
        const fullPath = path.join(currentDir, raw);
        if (isDir(fullPath)) {
          recurse && pendingDir.push(fullPath);
        } else {
          out.push(await this._outputFor(fullPath));
        }
      };

      const virtualFiles = this._virtual(currentDir, globName);
      for (const {name: raw, gen} of virtualFiles) {
        const fullPath = path.join(currentDir, raw);
        out.push(await this._outputFor(fullPath, gen));
      }

      // if this recurses into subdirs, reset glob
      globName = '*';
    }

    return out.filter((x) => x !== null);
  }

  async _outputFor(fullPath, gen=undefined) {
    let v = this._cache[fullPath];
    if (v === undefined) {
      v = {path: fullPath, gen, cf: null};
      if (gen !== undefined) {
        // generated files can't be read
        v.cf = new ContentFile(fullPath);
      } else {
        // read real file
        v.cf = await ContentFile._buildFromSource(fullPath);
      }

      this._cache[fullPath] = v;
    }
    return v;
  }
}

module.exports = {ContentLoader};