const core = require('@actions/core');
const mustache = require('mustache');
const fs = require('fs').promises;
const yaml = require('js-yaml');

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

  console.log('consul files', consulFiles)

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

    console.log('vault files', vaultFiles)
  }

  // Load the consul data
  console.log('connecting to consul');
  const consul = require('consul')({
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

  consulFiles.forEach(async consulFile => {
    console.log('getting values for the consul file', consulFile)
    if (!consulFile.consulKeys) {
      return
    }

    const consulValues = {}
    consulFile.consulValues = {}
    try {
      console.log('is consulValues declared?', consulValues, { consulFile })

      consulFile.consulKeys.forEach(async path => {
        console.log(`getting key vaules from consul at path ${path}`)

        const keys = await consul.kv.get({ key: path, recurse: true });
        console.log('keys', keys)
        for (const key of keys) {
          if (key.Key.slice(-1) === '/') {
            continue;
          }
          const keySplit = key.Key.split('/');
          consulValues[keySplit[keySplit.length - 1]] = key.Value;
          consulFile.consulValues[keySplit[keySplit.length - 1]] = key.Value;
        }
        console.log('inside foreach consul values', consulValues)
      })
    } catch (e) {
      console.log(`trouble getting values from consul (${e.message})`);
      throw e;
    }

    console.log('outside foreach consul values', consulValues, consulFile.consulValues)
    // consulFile.consulValues = consulValues
    // if (consulKeys.length > 0) { consulFile.consulKeys = new Map([...consulKeys].sort((a, b) => (a[1] > b[1] && 1) || (a[1] === b[1] ? 0 : -1))) }
  })

  console.log('sucessfully pulled values from consul')

  // Load the Vault data
  if (vaultFiles) {
    console.log('connecting to vault')

    if (vaultSkipVerify) {
      process.env.VAULT_SKIP_VERIFY = 'true';
    }

    const vault = require('node-vault')({
      token: vaultToken,
      endpoint: `${vaultSecure ? 'https://' : 'http://'}${vaultUrl}:${vaultport}`
    });

    vaultFiles.forEach(async vaultFile => {
      const vaultValues = {}
      try {
        console.log('is consulValues declared?', vaultValues, { vaultFile })

        vaultFile.vaultSecrets.forEach(async path => {
          console.log(`getting secret values from vault at path ${path}`)

          const keyList = await vault.list(path);
          console.log('keylist', keyList)
          for (const key of keyList.data.keys) {
            const keyValue = await vault.read(`${path}/${key}`);
            vaultValues[key] = Buffer.from(keyValue.data.value).toString('base64');
          }
        })
        // sort
        // if (vaultValues.length > 0) { vaultFile.vaultValues = new Map([...vaultValues].sort((a, b) => (a[1] > b[1] && 1) || (a[1] === b[1] ? 0 : -1))) }
      } catch (e) {
        console.log(`trouble getting values from vault ${e.message}`);
        throw e;
      }
      console.log('outside foreach vault vaules', vaultValues)
      vaultFile.vaultValues = vaultValues
    })
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
      try {
        consulFile.fileData = mustache.render(consulFile.fileData, consulFile.preParse)
      } catch (e) {
        console.log(`trouble pre-parsing files (${e.message})`)
        throw e
      }
    }
  })

  if (vaultFiles) {
    vaultFiles.forEach(vaultFile => {
      console.log(`${vaultFile.filePath}`)
      if (vaultFile.preParse) {
        try {
          vaultFile.fileData = mustache.render(vaultFile.fileData, vaultFile.preParse)
        } catch (e) {
          console.log(`trouble pre-parsing files (${e.message})`)
          throw e
        }
      }
    })
  }

  // Build the secrets if there are any
  if (vaultFiles) {
    console.log('building secrets data')
    try {
      vaultFiles.forEach(async vaultFile => {
        console.log(vaultFile.filePath)
        const secretYaml = await yaml.safeLoad(vaultFile.fileData)
        secretYaml.data = vaultFile.vaultValues
        vaultFile.secretName = secretYaml.metadata.name
        vaultFile.fileData = await yaml.safeDump(secretYaml)
      })
    } catch (e) {
      console.log(`trouble building secrets file (${e.message})`)
      throw e
    }
  }

  // Build the consul files
  console.log('building consul data')
  try {
    consulFiles.forEach(async consulFile => {
      // if we didn't grab any values from consul continue
      if (!consulFile.consulValues || consulFile.consulValues.length === 0) {
        return
      }

      console.log(`${consulFile.filePath}`)

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
    })
  } catch (e) {
    console.log(`trouble building consul file (${e.message})`)
    throw e
  }

  console.log('Writing output files');
  try {
    consulFiles.forEach(async consulFile => {
      console.log(consulFile.outFile)
      await fs.writeFile(consulFile.outFile, consulFile.fileData);
    })
  } catch (e) {
    console.log(`trouble writing deployment file (${e.message})`);
    throw e
  }

  if (vaultFiles) {
    try {
      vaultFiles.forEach(async vaultFile => {
        console.log(vaultFile.outFile)
        await fs.writeFile(vaultFile.outFile, vaultFile.fileData);
      })
    } catch (e) {
      console.log(`trouble writing deployment file (${e.message})`);
      throw e
    }
  }

  console.log('finished')
};

module.exports = { parseTemplate };
