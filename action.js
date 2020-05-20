import { getInput } from '@actions/core';
import { render } from 'mustache';
import { promises as fs } from 'fs';
import { safeLoad, safeDump } from 'js-yaml';

async function parseTemplate () {
  const consulUrl = getInput('consulUrl', { required: true });
  const consulport = getInput('consulPort', { required: true });
  const consulSecure = getInput('consulSecure', { required: false });
  const consulDatacenter = getInput('consulDatacenter', { required: false });
  const consulToken = getInput('consulToken', { required: false });
  const consulKey = getInput('consulKey', { required: true });
  const consulCA = getInput('consulCa', { require: false });
  const vaultUrl = getInput('vaultUrl', { required: true });
  const vaultport = getInput('vaultPort', { required: true });
  const vaultSecure = getInput('vaultSecure', { required: false });
  const vaultToken = getInput('vaultToken', { required: false });
  const vaultTokenRenew = getInput('vaultTokenRenew', { requied: false });
  const vaultSecret = getInput('vaultSecret', { required: true });
  const vaultSkipVerify = getInput('vaultSkipVerify', { required: false });
  const preParse = getInput('preParse', { requried: false });
  const deploymentFile = getInput('deploymentFile', { requried: true });
  const secretsFile = getInput('secretsFile', { requried: false });

  let deploymentOut
  let secretsOut
  let vaultValues
  let consulValues
  let deploymentData;
  let secretsData;
  let secretName;

  try {
    await fs.stat(deploymentFile)
    console.log('found deployment file')
    deploymentOut = `${deploymentFile}.parsed`;
    deploymentData = await fs.readFile(deploymentFile, 'utf-8')
  } catch (e) {
    console.log(`failed to read deployment file (${e.message})`)
    throw e;
  }

  if (secretsFile) {
    try {
      await fs.stat(secretsFile)
      console.log('found secrets file')
      secretsOut = `${secretsFile}.parsed`;
      secretsData = await fs.readFile(secretsFile, 'utf-8')
    } catch (e) {
      console.log(`failed to read secrets file (${e.message})`)
      throw e;
    }
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

  try {
    console.log(`getting key values from consul for ${consulKey}`);

    const keys = await consul.kv.get({ key: consulKey, recurse: true });
    for (const key of keys) {
      if (key.Key.slice(-1) === '/') {
        continue;
      }
      const keySplit = key.Key.split('/');
      consulValues[keySplit[keySplit.length - 1]] = key.Value;
    }
  } catch (e) {
    console.log(`trouble getting values from consul (${e.message})`);
    throw e;
  }

  console.log('sucessfully pulled values from consul')

  // Load the Vault data
  if (secretsFile) {
    console.log('connecting to vault')

    if (vaultSkipVerify) {
      process.env.VAULT_SKIP_VERIFY = 'true';
    }

    const vault = require('node-vault')({
      token: vaultToken,
      endpoint: `${vaultSecure ? 'https://' : 'http://'}${vaultUrl}:${vaultport}`
    });

    try {
      console.log(`getting secret values from vault at path ${vaultSecret}`);
      const keyList = await vault.list(vaultSecret);
      for (const key of keyList.data.keys) {
        const keyValue = await vault.read(`${vaultSecret}/${key}`);
        vaultValues[key] = Buffer.from(keyValue.data.value).toString('base64');
      }
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
  if (preParse) {
    console.log('pre-parsing templates with provided values')
    const preParseValues = JSON.parse(preParse)
    try {
      deploymentData = render(deploymentData, preParseValues)
      if (secretsData) {
        secretsData = render(secretsData, preParseValues)
      }
    } catch (e) {
      console.log(`trouble pre-parsing files (${e.message})`)
      throw e
    }
  }

  if (secretsData) {
    console.log('building secrets data')
    try {
      // parse the data into yaml
      const secretYaml = await safeLoad(secretsData)
      secretYaml.data = vaultValues
      secretName = secretYaml.metadata.name
      secretsData = await safeDump(secretYaml)
    } catch (e) {
      console.log(`trouble building secrets file (${e.message})`)
      throw e
    }
  }

  console.log('building deployment data')
  try {
    const deploymentYaml = await safeLoad(deploymentData)
    const containers = deploymentYaml.spec.template.spec.containers || []

    if (containers.length === 0) throw new Error('no containers in deployment')

    const env = []
    Object.entries(consulValues).forEach(([key, value]) => {
      env.push({ name: key, value: value })
    })

    if (secretsData) {
      Object.entries(vaultValues).forEach(([key]) => {
        env.push({
          name: key,
          valueFrom: {
            secretKeyRef: {
              name: secretName,
              key: key
            }
          }
        })
      })
    }

    deploymentYaml.spec.template.spec.containers.forEach(container => {
      container.env = env
    })
    deploymentData = await safeDump(deploymentYaml)
  } catch (e) {
    console.log(`trouble building deployment file )${e.message})`)
    throw e
  }

  console.log(`Writing output file ${deploymentOut}`);
  try {
    await fs.writeFile(deploymentOut, deploymentData);
  } catch (e) {
    console.log(`trouble writing deployment file (${e.message})`);
    throw e
  }

  if (secretsData) {
    console.log(`Writing output file ${secretsOut}`);
    try {
      await fs.writeFile(secretsOut, secretsData);
    } catch (e) {
      console.log(`trouble writing deployment file (${e.message})`);
      throw e
    }
  }
};

export default { parseTemplate };
