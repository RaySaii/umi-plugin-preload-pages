// ref:
// - https://umijs.org/plugin/develop.html
// - 参考 https://github.com/GoogleChromeLabs/preload-webpack-plugin/blob/master/index.js 这个实现
// - chunkGroup 的数据格式参考 https://github.com/webpack/webpack/blob/9fd6af8121e71718e786a2a18894d48acf2c47ed/lib/ChunkGroup.js
const { writeFileSync } = require('fs')
const { join } = require('path')
const flatten = require('lodash/flatten')
const uniq = require('lodash/uniq')

// normalizeEntry copy from https://github.com/umijs/umi/blob/master/packages/umi-build-dev/src/routes/routesToJSON.js#L83
function normalizeEntry(entry) {
  return entry
      .replace(/^.(\/|\\)/, '')
      .replace(/(\/|\\)/g, '__')
      .replace(/\.jsx?$/, '')
      .replace(/\.tsx?$/, '')
}

function getPreloadKey(route, preloadKeyGenerator) {
  let preloadKey
  if (preloadKeyGenerator) {
    preloadKey = preloadKeyGenerator(route)
  }
  return preloadKey || route.preloadKey || route.path || '__404' // __404 是为了配置路由的情况下的 404 页面
}

function patchDataWithRoutes(preloadMap, routes = [], chunkGroupData, parentChunks = [], dva, preloadKeyGenerator) {
  routes.forEach(route => {
    const key = getPreloadKey(route, preloadKeyGenerator)
    preloadMap[key] = preloadMap[key] || []
    const webpackChunkName = normalizeEntry(route.component || 'common_component')
        .replace(/^src__/, '')
        .replace(/^pages__/, 'p__')
        .replace(/^page__/, 'p__')
    const chunks = flatten(chunkGroupData.filter(group => {
      let isMatch = false
      if (group.name === webpackChunkName) {
        isMatch = true
      } else if (dva) {
        // p__user__test__models__data.js.js -> p_user__test
        const groupNameWithoutModel = group.name.replace(/__model.+$/, '')
        if (webpackChunkName.indexOf(groupNameWithoutModel) === 0) {
          // 只要 model 是在路由对应组件的文件夹下（包含上层文件夹下）那么 model 就会被 umi-plugin-dva 自动挂载
          // 这种情况下对应的 model 也需要加到预加载中
          isMatch = true
        }
      }
      return isMatch
    }).map(group => group.chunks))
    preloadMap[key] = uniq(preloadMap[key].concat(parentChunks).concat(chunks))
    patchDataWithRoutes(preloadMap, route.routes, chunkGroupData, preloadMap[key], dva, preloadKeyGenerator)
  })
}

function getPreloadData({ compilation }, routes, { useRawFileName, dva, preloadKeyGenerator }) {
  const allChunks = compilation.chunkGroups
  // preloadData like this:
  // {
  //   '/a': ['xxx.js', 'xxx.css'],
  // }
  //
  const preloadMap = {}
  const chunkGroupData = allChunks.map((group) => {
    return {
      name: group.name,
      chunks: flatten(group.chunks.map(chunk => {
        return chunk.files.filter(file => !/(\.map$)|(hot\-update\.js)/.test(file)).map(file => {
          if (useRawFileName) {
            return file.replace(/\.\w{8}.chunk.css$/, '.css').replace(/\.\w{8}.async.js$/, '.js')

          }
          return file
        })
      })),
    }
  })
  patchDataWithRoutes(preloadMap, routes, chunkGroupData, [], dva, preloadKeyGenerator)
  let preloadArr = [...new Set(Object.keys(preloadMap).reduce((prev, key) => prev.concat(preloadMap[key]), []))]
  return preloadMap
}

const PRELOAD_FILENAME = 'preload.json'
module.exports = function (api, options = {}) {
  const { paths, debug } = api
  const { useRawFileName = false, dva = false, preloadKeyGenerator } = options

  function writePreloadData(target, data) {
    debug(`will write preload file to ${target}`)
    writeFileSync(target, JSON.stringify(data, null, 2))
    debug(`write preload file to ${target}`)
  }

  if(process.env.NODE_ENV=='production'){
    api.addHTMLScript({
      content: `
      fetch(window.routerBase+'preload.json')
        .then(res=>res.json())
        .then(json=>{
            const links=document.getElementsByTagName('link')
            const firstLink = links[0]
            const hasAdd=[]
            Object.keys(json).forEach(path=>{
                if(window.g_history.location.pathname==path)return 
                const arr=json[path]
                arr.forEach(name=>{
                  const link = document.createElement('link')
                  link.href = '${api.config.publicPath}'+name
                  link.rel='preload'
                  link.as=name.endsWith('.js')?'script':'style'
                  if(hasAdd.includes(name))return
                  hasAdd.push(name) 
                  firstLink.parentNode.insertBefore(link, firstLink)
                })
            })
        })
    `,
    })
  }



  api.onBuildSuccess(({ stats }) => {
    const targetStats = Array.isArray(stats.stats) ? stats.stats[0] : stats
    const preloadMap = getPreloadData(targetStats, api.routes, {
      useRawFileName,
      dva,
      preloadKeyGenerator,
    })
    const filePath = join(paths.absOutputPath, PRELOAD_FILENAME)
    writePreloadData(filePath, preloadMap)
  })
}

