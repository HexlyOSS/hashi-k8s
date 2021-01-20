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

  const cfParsed = JSON.parse(consulKeys)
  if (cfParsed.length === 0) {
    throw new Error('no files provided')
  }

  consulFiles = await Promise.all(cfParsed.map(async cf => {
    try {
      await fs.stat(cf.filePath)
      cf.outFile = `${cf.filePath}.parsed`
      cf.fileData = await fs.readFile(cf.filePath, 'utf-8')

      return cf
    } catch (e) {
      console.log(`failed to parse consulKeys input (${e.message})`)
      throw e
    }
  }))

  if (vaultSecrets) {
    const vfParsed = await JSON.parse(vaultSecrets)

    vaultFiles = await Promise.all(vfParsed.map(async vf => {
      try {
        await fs.stat(vf.filePath)
        vf.outFile = `${vf.filePath}.parsed`
        vf.fileData = await fs.readFile(vf.filePath, 'utf-8')

        return vf
      } catch (e) {
        console.log(`failed to parse vaultSecrets input (${e.message})`)
        throw e;
      }
    }))
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

  consulFiles = await Promise.all(consulFiles.map(async cf => {
    console.log('getting values for the consul file')
    if (!cf.consulKeys) {
      return cf
    }

    try {
      const vals = await loadConsulValues({ consul, paths: cf.consulKeys })
      cf.consulValues = vals.data
      return cf
    } catch (e) {
      console.log(`trouble getting values from consul (${e.message})`);
      throw e;
    }
  }))

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

    vaultFiles = await Promise.all(vaultFiles.map(async vf => {
      try {
        const vals = await loadVaultValues({ vault, paths: vf.vaultSecrets })
        vf.vaultValues = vals.data
        return vf
      } catch (e) {
        console.log(`trouble getting values from consul (${e.message})`);
        throw e;
      }
    }))

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
  consulFiles = await Promise.all(consulFiles.map(async cf => {
    if (cf.preParse) {
      console.log(`${cf.filePath}`)
      try {
        cf.fileData = mustache.render(cf.fileData, cf.preParse)
        return cf
      } catch (e) {
        console.log(`trouble pre-parsing files (${e.message})`)
        throw e
      }
    } else {
      return cf
    }
  }))

  if (vaultFiles) {
    vaultFiles = await Promise.all(vaultFiles.map(async vf => {
      console.log(`${vf.filePath}`)
      if (vf.preParse) {
        try {
          vf.fileData = mustache.render(vf.fileData, vf.preParse)
          return vf
        } catch (e) {
          console.log(`trouble pre-parsing files (${e.message})`)
          throw e
        }
      } else {
        return vf
      }
    }))
  }

  // Build the secrets if there are any
  if (vaultFiles) {
    console.log('building secrets data')
    vaultFiles = await Promise.all(vaultFiles.map(async vf => {
      try {
        console.log(vf.filePath)

        const secretYaml = await yaml.safeLoad(vf.fileData)
        secretYaml.data = vf.vaultValues

        vf.secretName = secretYaml.metadata.name
        vf.fileData = await yaml.safeDump(secretYaml)

        return vf
      } catch (e) {
        console.log(`trouble building secrets file (${e.message})`)
        throw e
      }
    }))
  }

  // Build the consul files
  console.log('building consul data')
  consulFiles = await Promise.all(consulFiles.map(async cf => {
    // if we didn't grab any values from consul continue
    if (!cf.consulValues || cf.consulValues.length === 0) {
      return cf
    }

    console.log(cf.filePath)

    try {
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

      return cf
    } catch (e) {
      console.log(`trouble building consul file (${e.message})`)
      throw e
    }
  }))

  console.log('Writing output files');
  await consulFiles.forEach(async cf => {
    try {
      console.log(cf.outFile)
      await fs.writeFile(cf.outFile, cf.fileData);
    } catch (e) {
      console.log(`trouble writing deployment file (${e.message})`);
      throw e
    }
  })

  if (vaultFiles) {
    await vaultFiles.forEach(async vf => {
      try {
        console.log(vf.outFile)
        await fs.writeFile(vf.outFile, vf.fileData);
      } catch (e) {
        console.log(`trouble writing deployment file (${e.message})`);
        throw e
      }
    })
  }

  console.log('finished')
};

module.exports = { parseTemplate };

async function loadConsulValues ({ consul, paths }) {
  return await Promise.all(paths.map(async path => {
    console.log(`getting key vaules from consul at path ${path}`)
    try {
      const keys = await consul.kv.get({ key: path, recurse: true });
      console.log('keys', keys)

      const vals = {}
      for (const key of keys) {
        if (key.Key.slice(-1) === '/') {
          continue;
        }
        const keySplit = key.Key.split('/');
        vals[keySplit[keySplit.length - 1]] = key.Value;
      }

      return vals
    } catch (e) {
      throw new Error(`"unable to fetch consul value (${e.messages})"`)
    }
  }))
}

async function loadVaultValues ({ vault, paths }) {
  return await Promise.all(paths.map(async path => {
    console.log(`getting secret values from vault at path ${path}`)

    try {
      const keyList = await vault.list(path);

      const vals = {}
      for (const key of keyList.data.keys) {
        const keyValue = await vault.read(`${path}/${key}`);
        vals[key] = Buffer.from(keyValue.data.value).toString('base64');
      }

      return vals
    } catch (e) {
      throw new Error(`"unable to fetch vault secret (${e.messages})"`)
    }
  }))
}
