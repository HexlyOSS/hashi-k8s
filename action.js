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

  // let consulFiles
  let vaultFiles

  const consulFiles = JSON.parse(consulKeys)
  if (consulFiles.length === 0) {
    throw new Error('no files provided')
  }

  await consulFiles.forEach(async cf => {
    try {
      await fs.stat(cf.filePath)
      cf.outFile = `${cf.filePath}.parsed`
      cf.fileData = await fs.readFile(cf.filePath, 'utf-8')
    } catch (e) {
      console.log(`failed to parse consulKeys input (${e.message})`)
      throw e
    }
  })

  if (vaultSecrets) {
    vaultFiles = await JSON.parse(vaultSecrets)

    await vaultFiles.forEach(async vf => {
      try {
        await fs.stat(vf.filePath)
        vf.outFile = `${vf.filePath}.parsed`
        vf.fileData = await fs.readFile(vf.filePath, 'utf-8')
      } catch (e) {
        console.log(`failed to parse vaultSecrets input (${e.message})`)
        throw e;
      }
    })
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

  await consulFiles.forEach(async cf => {
    console.log('getting values for the consul file')
    if (!cf.consulKeys) {
      return cf
    }

    try {
      const vals = await loadConsulValues({ consul, paths: cf.consulKeys })
      cf.consulValues = vals.data
    } catch (e) {
      console.log(`trouble getting values from consul (${e.message})`);
      throw e;
    }
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

    await vaultFiles.forEach(async vf => {
      try {
        const vals = await loadVaultValues({ vault, paths: vf.vaultSecrets })
        console.log('got vault vals', vals)
        vf.vaultValues = vals.data
      } catch (e) {
        console.log(`trouble getting values from consul (${e.message})`);
        throw e;
      }
    })

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
  await consulFiles.forEach(async cf => {
    if (cf.preParse) {
      console.log(`${cf.filePath}`)
      try {
        cf.fileData = mustache.render(cf.fileData, cf.preParse)
      } catch (e) {
        console.log(`trouble pre-parsing files (${e.message})`)
        throw e
      }
    }
  })

  if (vaultFiles) {
    await vaultFiles.forEach(async vf => {
      console.log(`${vf.filePath}`)
      if (vf.preParse) {
        try {
          vf.fileData = mustache.render(vf.fileData, vf.preParse)
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
      await vaultFiles.forEach(async vf => {
        console.log(vf.filePath)
        const secretYaml = await yaml.safeLoad(vf.fileData)
        secretYaml.data = vf.vaultValues
        vf.secretName = secretYaml.metadata.name
        vf.fileData = await yaml.safeDump(secretYaml)
      })
    } catch (e) {
      console.log(`trouble building secrets file (${e.message})`)
      throw e
    }
  }

  // Build the consul files
  console.log('building consul data')
  try {
    await consulFiles.forEach(async cf => {
      // if we didn't grab any values from consul continue
      if (!cf.consulValues || cf.consulValues.length === 0) {
        return
      }

      console.log(cf.filePath)

      const deploymentYaml = await yaml.safeLoad(cf.fileData)
      if (deploymentYaml.kind !== 'Deployment') {
        console.log('only Deployments supported', cf.filePath)
        return
      }

      const containers = deploymentYaml.spec.template.spec.containers || []
      if (containers.length === 0) throw new Error('no containers in deployment')

      const env = []

      // push the consul values into the env arrya
      Object.entries(cf.consulValues).forEach(([key, value]) => {
        env.push({ name: key, value: value })
      })

      // if they referenced a vault secret, push it here
      const vs = cf.vaultSecrets || []
      await vs.forEach(secret => {
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

      cf.fileData = await yaml.safeDump(deploymentYaml)
    })
  } catch (e) {
    console.log(`trouble building consul file (${e.message})`)
    throw e
  }

  console.log('Writing output files');
  try {
    await consulFiles.forEach(async consulFile => {
      console.log(consulFile.outFile)
      await fs.writeFile(consulFile.outFile, consulFile.fileData);
    })
  } catch (e) {
    console.log(`trouble writing deployment file (${e.message})`);
    throw e
  }

  if (vaultFiles) {
    try {
      await vaultFiles.forEach(async vaultFile => {
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

async function loadConsulValues ({ consul, paths }) {
  const vals = {}

  await paths.forEach(async path => {
    console.log(`getting key vaules from consul at path ${path}`)
    try {
      const keys = await consul.kv.get({ key: path, recurse: true });
      console.log('keys', keys)

      for (const key of keys) {
        if (key.Key.slice(-1) === '/') {
          continue;
        }
        const keySplit = key.Key.split('/');
        vals[keySplit[keySplit.length - 1]] = key.Value;
      }
    } catch (e) {
      throw new Error(`"unable to fetch consul value (${e.messages})"`)
    }
  })

  return vals
}

async function loadVaultValues ({ vault, paths }) {
  const vals = {}

  await paths.forEach(async path => {
    console.log(`getting secret values from vault at path ${path}`)

    try {
      const keyList = await vault.list(path);
      console.log('keylist', keyList)

      for (const key of keyList.data.keys) {
        const keyValue = await vault.read(`${path}/${key}`);
        vals[key] = Buffer.from(keyValue.data.value).toString('base64');
      }
    } catch (e) {
      throw new Error(`"unable to fetch vault secret (${e.messages})"`)
    }
  })

  return vals
}
