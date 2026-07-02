'use strict'

import Asciidoctor from '@asciidoctor/core'
import fs from 'fs-extra'
import handlebars from 'handlebars'
import merge from 'merge-stream'
import ospath from 'path'
const path = ospath.posix
import requireFromString from 'require-from-string'
import { Transform } from 'stream'
const map = (transform = () => {}, flush = undefined) => new Transform({ objectMode: true, transform, flush })
import vfs from 'vinyl-fs'
import yaml from 'js-yaml'

const asciidoctor = Asciidoctor()
const ASCIIDOC_ATTRIBUTES = { experimental: '', icons: 'font', sectanchors: '', 'source-highlighter': 'highlight.js' }

export default (src, previewSrc, previewDest, sink = () => map()) => async (done) => {
  try {
    const [baseUiModel, { layouts }] = await Promise.all([
      loadSampleUiModel(previewSrc),
      toPromise(
        merge(compileLayouts(src), registerPartials(src), registerHelpers(src), copyImages(previewSrc, previewDest))
      ),
    ])

    const extensions = ((baseUiModel.asciidoc || {}).extensions || []).map((request) => {
      ASCIIDOC_ATTRIBUTES[request.replace(/^@|\.js$/, '').replace(/[/]/g, '-') + '-loaded'] = ''
      const extension = require(request)
      extension.register.call(asciidoctor.Extensions)
      return extension
    })
    const asciidocConfig = { extensions }
    for (const component of baseUiModel.site.components) {
      for (const version of component.versions || []) version.asciidoc = asciidocConfig
    }
    const updatedUiModel = { ...baseUiModel, env: process.env }
    delete updatedUiModel.asciidoc

    await new Promise((resolve, reject) => {
      vfs
        .src('**/*.adoc', { base: previewSrc, cwd: previewSrc })
        .pipe(
          map(async (file, enc, next) => {
            try {
              const siteRootPath = path.relative(ospath.dirname(file.path), ospath.resolve(previewSrc))
              const uiModel = { ...updatedUiModel }
              uiModel.page = { ...uiModel.page }
              uiModel.siteRootPath = siteRootPath
              uiModel.uiRootPath = path.join(siteRootPath, '_')
              if (file.stem === '404') {
                uiModel.page = { layout: '404', title: 'Page Not Found' }
              } else {
                const doc = await asciidoctor.load(file.contents, { safe: 'safe', attributes: ASCIIDOC_ATTRIBUTES })
                uiModel.page.attributes = Object.entries(doc.getAttributes())
                  .filter(([name, val]) => name.startsWith('page-'))
                  .reduce((accum, [name, val]) => {
                    accum[name.slice(5)] = val
                    return accum
                  }, {})
                uiModel.page.layout = doc.getAttribute('page-layout', 'default')
                uiModel.page.title = doc.getDocumentTitle()
                const converted = await doc.convert()
                uiModel.page.contents = Buffer.from(converted)
              }
              file.extname = '.html'
              try {
                file.contents = Buffer.from(layouts.get(uiModel.page.layout)(uiModel))
                next(null, file)
              } catch (e) {
                next(transformHandlebarsError(e, uiModel.page.layout))
              }
            } catch (error) {
              next(error)
            }
          })
        )
        .pipe(vfs.dest(previewDest))
        .on('error', reject)
        .on('finish', resolve)
        .pipe(sink())
    })

    done()
  } catch (error) {
    done(error)
  }
}

function loadSampleUiModel (src) {
  console.log('Loading sample UI model from', ospath.join(src, 'ui-model.yml'))
  return fs.readFile(ospath.join(src, 'ui-model.yml'), 'utf8').then((contents) => yaml.load(contents))
}

function registerPartials (src) {
  return vfs.src('partials/*.hbs', { base: src, cwd: src }).pipe(
    map((file, enc, next) => {
      handlebars.registerPartial(file.stem, file.contents.toString())
      next()
    })
  )
}

function registerHelpers (src) {
  handlebars.registerHelper('resolvePage', resolvePage)
  handlebars.registerHelper('resolvePageURL', resolvePageURL)
  return vfs.src('helpers/*.js', { base: src, cwd: src }).pipe(
    map((file, enc, next) => {
      handlebars.registerHelper(file.stem, requireFromString(file.contents.toString()))
      next()
    })
  )
}

function compileLayouts (src) {
  const layouts = new Map()
  return vfs.src('layouts/*.hbs', { base: src, cwd: src }).pipe(
    map(
      (file, enc, next) => {
        const srcName = path.join(src, file.relative)
        layouts.set(file.stem, handlebars.compile(file.contents.toString(), { preventIndent: true, srcName }))
        next()
      },
      function (done) {
        this.push({ layouts })
        done()
      }
    )
  )
}

function copyImages (src, dest) {
  return vfs
    .src('**/*.{png,svg}', { base: src, cwd: src })
    .pipe(vfs.dest(dest))
    .pipe(map((file, enc, next) => next()))
}

function resolvePage (spec, context = {}) {
  if (spec) return { pub: { url: resolvePageURL(spec) } }
}

function resolvePageURL (spec, context = {}) {
  if (spec) return '/' + (spec = spec.split(':').pop()).slice(0, spec.lastIndexOf('.')) + '.html'
}

function transformHandlebarsError ({ message, stack }, layout) {
  const m = stack.match(/^ *at Object\.ret \[as (.+?)\]/m)
  const templatePath = `src/${m ? 'partials/' + m[1] : 'layouts/' + layout}.hbs`
  const err = new Error(`${message}${~message.indexOf('\n') ? '\n^ ' : ' '}in UI template ${templatePath}`)
  err.stack = [err.toString()].concat(stack.slice(message.length + 8)).join('\n')
  return err
}

function toPromise (stream) {
  return new Promise((resolve, reject, data = {}) =>
    stream
      .on('error', reject)
      .on('data', (chunk) => chunk.constructor === Object && Object.assign(data, chunk))
      .on('finish', () => resolve(data))
  )
}
