hashi-k8s
---
Github action to build deployment and secrets yaml for k8s from Hashicorps onsul and vault.

This is an opinionated action that will look for a consul key and vault secret and add all the defined values to the running environment of a deployment. I will grab the vault values and put them into a k8s secret, then reference that secret in the deployment.

This action requires you to provide an essentially complete deployments/secrets file. It simply fills out the `spec.template.spce.containers[*].env` section with values from consul. For secret data, it will put data from vault in the `data` section of the secrets yaml, then link to that data in the deployment yaml.

If you want to update the files with any additional data before parsing it you can provide the `preParse` option which should be a json map of key/values that will be parsed via mustache.js.

## Example Usage

```yaml
jobs:
  parse:
    steps:
      - name: Hashi K8s
        uses: hexlyOSS/hashi-k8s@v1
        with:
          consulUrl: "consul.hexlyoss.io"
          consulPort: "8501"
          consulSecure: true
          consulDatacenter: "dc1"
          consulToken: ${{ secrets.CONSUL_TOKEN }}
          consulkey: "staging/processor/"
          vaultUrl: "vault.hexlyoss.io"
          vaultPort: "8200"
          vaultSecret: "staging/test/"
          vaultToken: ${{ secrets.VAULT_TOKEN }}
          vaultTokenRenew: true
          preParse: '{"project": "processor", "lane":"staging", "releaseSha": "abc123"}'
          deploymentFile: 'deployment.yaml'
          secretsFile: 'secrets.yaml'
          consulCa: |
            -----BEGIN CERTIFICATE-----
            MIIDLzCCAhegAwIBAgIUVGKmsphw41gg4dxHQWBLckt8giYwDQYJKoZIhvcNAQEL
            BQAwFDESMBAGA1UEAxMJY2EuY29uc3VsMB4XDTE5MDMyNTE2MzQ1OVoXDTI4MTEx
            NzE2MzUyOVowFDESMBAGA1UEAxMJY2EuY29uc3VsMIIBIjANBgkqhkiG9w0BAQEF
            AAOCAQ8AMIIBCgKCAQEAzkUpLw0DOXsCaaQnifxK4Mt7TfwGOH09f7rZRJlYueXo
            iNfR0kLlqR34oITDSRP+dOxuMFDd5TkVxGK7TPRc2QjbQarho8Jn97joeuigRo/l
            DdXodryPDKgTiYj3ogZ4i/MVqZeAeMxSgQkmmNV97UFPqLGWbsCISkg2XkFM98Nk
            mMczmiNEMwT3Jp/qPCQ52MxojN3LsaNxIbqX0F60cbGjnYc8Vkik3C5cZgc7AlQI
            WKtu9AZ1md4fv3P6CSv0reiG8NFR7CmdjV1s3+V6wIRVYdmdNcICHMBmNLu6sSue
            q6FeBaoh7rESRF+TGNAmQQlhkEr2F3rlvy34GSmFvwIDAQABo3kwdzAOBgNVHQ8B
            Af8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUTze1cndYO46QuRt3
            g5zA4S0r41YwHwYDVR0jBBgwFoAUTze1cndYO46QuRt3g5zA4S0r41YwFAYDVR0R
            BA0wC4IJY2EuY29uc3VsMA0GCSqGSIb3DQEBCwUAA4IBAQCWdI12SrkmTjfGIDGZ
            LBTYBoqWZ/qObzlBcAqOzyeAOIq+92+AfqxPzpvwfI+PFhRg+hZ8ZXoV2LnnjxbN
            JHUG6CleMvYQIBPxVIrCDmTQ4dwL7bWmuWQaQD7MDsIcEOEm1qEQ1y3zfMIko0CE
            wq0tHETtC8bgI32mtkdRojdovVT55I8csNyJTMmjeirhAHUucr4O5DDzsFv3MliN
            XXlGqyv6afF860VtOmrCePP24SBK5bUs6vOge7T50fCHQ1h8ASyhrcREmaYf72CH
            c3s/pzsKYaZpWd867pIGN8JZBscRLDyvPhde4zxZirOWcdOIIbpUsv1VUi7OcEXL
            lPCJ
            -----END CERTIFICATE-----
```

## Input Values

### consulUrl

**Required** Consul agent address

### consulPort

**Required** Consul agent port

### consulSecure

Enable https connection to consul. Default `true`.

### consulCa

Custom CA certificate for consul service. Default `none`.

### consulDatacenter

Consul datacenter to use. Default `dc1`.

### consulKeys

**Required** Key path to use - the root to look for keys under. This can be a comma separated list of paths:

```
"prod/example-service/,prod/common-config/"
```

These keys will all be added to the deployement config as env vars under the `keyname`. For example, if there is a key with the name `NATS_CLUSTER` it will be added to the deployment as:

```yaml
env:
  - name: 'NATS_CLUSTER'
    value: 'consul_value'
```

An array of maps indicating the files to parse with their associated keys and preParse values:

```json
  [
    {
      "filePath": "/path/to/file",
      "consulKeys": ["consul/keys/","to/parse/"],
      "preParse": {
        "key": "value"
      },
      "vaultSecrets": ["", ""]
    }
  ]
```

`filePath` is relative to the src directory.

`consulKeys` is an array of paths to look for in consul. All the key/value pairs at the indicated location will be added to the file under the `yamlPath` specified.

`preParse` is a map of values that will be applied to the file using `mustache.js`

`yamlPath` is the path within the k8s yaml that you want the consul keys to be added to

`vaultSecrets` reference to the vault secrets you want to be included in the yaml path

### consulToken

Consul ACL token to use if required. Default `none`.

### deploymentFile

**Depreciated** - use `consulKeys`

Path to depoloyment yaml file to parse.

### vaultUrl

Vault address. Required for secrets.

### vaultPort

Vault port. Required for secrets.

### vaultSecure

Enable https connection to vault. Default `false`.

### vaultSkipVerify

Skip mTLS check when connecting to vault. Default `false`.

### vaultToken

Vault token to use.  Default `none`.

### vaultRenewToken

Attempt to renew the token after use. Default `false`.

### vaultSecrets

An array of maps indicating the files to parse with their associated keys and preParse values:

```json
  [
    {
      "filePath": "/path/to/file",
      "vaultSecrets": ["consul/keys/","to/parse/"],
      "preParse": {
        "key": "value"
      }
    }
  ]
```

`filePath` is relative to the src directory.

`vaultSecrets` is an array of paths to look for in vault. All the key/value pairs at the indicated location will be added to the secrets file under the `data` section.

`preParse` is a map of values that will be applied to the file using `mustache.js`

### vaultSecret

**Depriciated** - use `vaultSecrets`

Secret (path) in vault to look for values under.

### secretsFile

**Depriciated** - use `vaultSecrets`

Required if vault data is needed. Path to secrets yaml file to parse.

### preParse

**Depreciated** - use `consulKeys`

Values to be used to pre-parse the yaml files. Default `none`.

## Output

consul-values will parse the provided `deployment` and `secrets` file with the values from consul `key` and vault `secret` and write the output to `<deploymentFile>.parsed` and `<secretsFile>.parsed`.