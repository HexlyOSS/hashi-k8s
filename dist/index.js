module.exports =
/******/ (function(modules, runtime) { // webpackBootstrap
/******/ 	"use strict";
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId]) {
/******/ 			return installedModules[moduleId].exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	__webpack_require__.ab = __dirname + "/";
/******/
/******/ 	// the startup function
/******/ 	function startup() {
/******/ 		// Load entry module and return exports
/******/ 		return __webpack_require__(888);
/******/ 	};
/******/
/******/ 	// run startup
/******/ 	return startup();
/******/ })
/************************************************************************/
/******/ ({

/***/ 29:
/***/ (function() {

eval("require")("@actions/core");


/***/ }),

/***/ 99:
/***/ (function() {

eval("require")("mustache");


/***/ }),

/***/ 198:
/***/ (function(module, __unusedexports, __webpack_require__) {

const core = __webpack_require__(29);
const mustache = __webpack_require__(99);
const fs = __webpack_require__(747).promises;
const yaml = __webpack_require__(686);

async function parseTemplate () {
  const consulUrl = core.getInput('consulUrl', { required: true });
  const consulport = core.getInput('consulPort', { required: true });
  const consulSecure = core.getInput('consulSecure', { required: false });
  const consulDatacenter = core.getInput('consulDatacenter', { required: false });
  const consulToken = core.getInput('consulToken', { required: false });
  const consulKeys = core.getInput('consulKeys', { required: true });
  const consulCA = core.getInput('consulCa', { require: false });
  const vaultUrl = core.getInput('vaultUrl', { required: false });
  const vaultport = core.getInput('vaultPort', { required: false });
  const vaultSecure = core.getInput('vaultSecure', { required: false });
  const vaultToken = core.getInput('vaultToken', { required: false });
  const vaultTokenRenew = core.getInput('vaultTokenRenew', { requied: false });
  const vaultSecrets = core.getInput('vaultSecrets', { required: false });
  const vaultSkipVerify = core.getInput('vaultSkipVerify', { required: false });

  let consulFiles
  let vaultFiles

  try {
    consulFiles = JSON.parse(consulKeys)
    if (consulFiles.length === 0) {
      throw new Error('no files provided')
    }

    consulFiles.forEach(async consulFile => {
      await fs.stat(consulFile.filePath)
      consulFile.outFile = `${consulFile.filePath}.parsed`
      consulFile.fileData = await fs.readFile(consulFile.filePath, 'utf-8')
    })
  } catch (e) {
    console.log(`failed to parse consulKeys input (${e.message})`)
    throw e
  }

  if (vaultSecrets) {
    try {
      vaultFiles = JSON.parse(vaultSecrets)

      vaultFiles.forEach(async vaultFile => {
        await fs.stat(vaultFile.filePath)
        vaultFile.outFile = `${vaultFile.filePath}.parsed`
        vaultFile.fileData = await fs.readFile(vaultFile.filePath, 'utf-8')
      })
    } catch (e) {
      console.log(`failed to parse vaultSecrets input (${e.message})`)
      throw e;
    }
  }

  // Load the consul data
  console.log('connecting to consul');
  const consul = __webpack_require__(279)({
    host: consulUrl,
    port: consulport,
    secure: consulSecure,
    ca: [consulCA],
    defaults: {
      dc: consulDatacenter | 'dc1',
      token: consulToken
    },
    promisify: true
  });

  try {
    consulFiles.forEach(async consulFile => {
      if (!consulFile.consulKeys) {
        return
      }

      consulFile.consulKeys.forEach(async path => {
        console.log(`getting key vaules from consul at path ${path}`)

        const keys = await consul.kv.get({ key: path, recurse: true });
        for (const key of keys) {
          if (key.Key.slice(-1) === '/') {
            continue;
          }
          const keySplit = key.Key.split('/');
          consulFile.consulValues[keySplit[keySplit.length - 1]] = key.Value;
        }
      })
    })
  } catch (e) {
    console.log(`trouble getting values from consul (${e.message})`);
    throw e;
  }

  console.log('sucessfully pulled values from consul')

  // Load the Vault data
  if (vaultFiles) {
    console.log('connecting to vault')

    if (vaultSkipVerify) {
      process.env.VAULT_SKIP_VERIFY = 'true';
    }

    const vault = __webpack_require__(652)({
      token: vaultToken,
      endpoint: `${vaultSecure ? 'https://' : 'http://'}${vaultUrl}:${vaultport}`
    });

    try {
      vaultFiles.forEach(async vaultFile => {
        const paths = vaultFile.vaultSecrets.split(',')

        paths.forEach(async path => {
          console.log(`getting secret values from vault at path ${path}`)

          const keyList = await vault.list(path);
          for (const key of keyList.data.keys) {
            const keyValue = await vault.read(`${path}/${key}`);
            vaultFile.vaultValues[key] = Buffer.from(keyValue.data.value).toString('base64');
          }
        })
      })
    } catch (e) {
      console.log(`trouble getting values from vault ${e.message}`);
      throw e;
    }

    console.log('sucessfully pulled values from vault')

    if (vaultTokenRenew) {
      try {
        console.log('renewing vault token');
        await vault.tokenRenewSelf()
      } catch (e) {
        console.log(`failed to renew vault token (${e.message})`);
        throw e
      }
    }
  }

  // preParse the files if necessary
  console.log('pre-parsing templates with provided values')
  consulFiles.forEach(consulFile => {
    if (consulFile.preParse) {
      console.log(`${consulFile.filePath}`)
      const preParseValues = JSON.parse(consulFile.preParse)
      try {
        consulFile.fileData = mustache.render(consulFile.fileData, preParseValues)
      } catch (e) {
        console.log(`trouble pre-parsing files (${e.message})`)
        throw e
      }
    }
  })

  if (vaultFiles) {
    vaultFiles.forEach(vaultFile => {
      console.log(`${vaultFile.filePath}`)
      const preParseValues = JSON.parse(vaultFile.preParse)
      try {
        vaultFile.fileData = mustache.render(vaultFile.fileData, preParseValues)
      } catch (e) {
        console.log(`trouble pre-parsing files (${e.message})`)
        throw e
      }
    })
  }

  // Build the secrets if there are any
  if (vaultFiles) {
    console.log('building secrets data')
    vaultFiles.forEach(async vaultFile => {
      console.log(vaultFile.filePath)
      try {
        const secretYaml = await yaml.safeLoad(vaultFiles.fileData)
        secretYaml.data = vaultFile.vaultValues
        vaultFile.secretName = secretYaml.metadata.name
        vaultFile.fileData = await yaml.safeDump(secretYaml)
      } catch (e) {
        console.log(`trouble building secrets file (${e.message})`)
        throw e
      }
    })
  }

  // Build the consul files
  console.log('building consul data')
  consulFiles.forEach(async consulFile => {
    // if we didn't grab any values from consul continue
    if (!consulFile.consulValues) {
      return
    }

    console.log(`${consulFile.filePath}`)

    try {
      const deploymentYaml = await yaml.safeLoad(consulFile.fileData)
      if (deploymentYaml.kind !== 'Deployment') {
        throw new Error('only Deployments supported')
      }

      const containers = deploymentYaml.spec.template.spec.containers || []
      if (containers.length === 0) throw new Error('no containers in deployment')

      const env = []

      // push the consul values into the env arrya
      Object.entries(consulFile.consulValues).forEach(([key, value]) => {
        env.push({ name: key, value: value })
      })

      // if they referenced a vault secret, push it here
      const vs = consulFile.vaultSecrets || []
      vs.forEach(secret => {
        if (!vaultFiles) throw new Error(`invalid vault secret reference ${secret}`)

        const vaultFile = vaultFiles.find(vf => vf.filePath === secret)

        if (!vaultFile) throw new Error(`invalid vault secret reference ${secret}`)

        Object.entries(vaultFile.vaultValues).forEach(([key]) => {
          env.push({
            name: key,
            valueFrom: {
              secretKeyRef: {
                name: vaultFile.secretName,
                key: key
              }
            }
          })
        })
      })

      // push built env array to each container spec
      deploymentYaml.spec.template.spec.containers.forEach(container => {
        container.env.push(...env)
      })

      consulFile.fileData = await yaml.safeDump(deploymentYaml)
    } catch (e) {
      console.log(`trouble building consul file (${e.message})`)
      throw e
    }
  })

  console.log('Writing output files');
  consulFiles.forEach(async consulFile => {
    console.log(consulFile.outFile)
    try {
      await fs.writeFile(consulFile.outFile, consulFile.fileData);
    } catch (e) {
      console.log(`trouble writing deployment file (${e.message})`);
      throw e
    }
  })

  if (vaultFiles) {
    vaultFiles.forEach(async vaultFile => {
      console.log(vaultFile.outFile)
      try {
        await fs.writeFile(vaultFile.outFile, vaultFile.fileData);
      } catch (e) {
        console.log(`trouble writing deployment file (${e.message})`);
        throw e
      }
    })
  }

  console.log('finished')
};

module.exports = { parseTemplate };


/***/ }),

/***/ 279:
/***/ (function() {

eval("require")("consul");


/***/ }),

/***/ 652:
/***/ (function() {

eval("require")("node-vault");


/***/ }),

/***/ 686:
/***/ (function() {

eval("require")("js-yaml");


/***/ }),

/***/ 747:
/***/ (function(module) {

module.exports = require("fs");

/***/ }),

/***/ 888:
/***/ (function(__unusedmodule, __unusedexports, __webpack_require__) {


const core = __webpack_require__(29);
const { parseTemplate } = __webpack_require__(198);

(async () => {
  try {
    await core.group('Parse template', parseTemplate);
  } catch (error) {
    core.setFailed(error.message);
  }
})()


/***/ })

/******/ });