---
title: Log in with your SSH agent
description: Version 3.6 lets the Mapepire driver log in to the IBM i through an SSH agent, so the key can have a passphrase and nothing unencrypted sits on disk.
date: 2026-10-09T18:00:00Z
tags: [release, drivers, mapepire]
audience: ibmi
---

Until now the Mapepire driver had two ways to log in over SSH: the user profile's password, or a private key file without a passphrase. Many IBM i teams allow neither. sshd on the IBM i is set to public key only, and the security policy says every private key has a passphrase. A key you can't decrypt without typing it in doesn't work for a server that starts on its own. Version 3.6 adds the third way: an SSH agent holds the key, and the Model Context Protocol (MCP) server asks the agent to sign the login.

This one came from outside. Vincent Rollin ([vrn on GitHub](https://github.com/vrn)) wrote up the problem in [issue 269](https://github.com/Strom-Capital/mcp-server-db2i/issues/269), then sent [pull request 270](https://github.com/Strom-Capital/mcp-server-db2i/pull/270) with the feature, the docs and the tests, checked on macOS and on Windows with both agents. I reviewed it, tightened a few edge cases and merged it. Thank you, Vincent. It's the first feature in this project built by someone other than me.

## How it works

Set `agent` in `DB2I_MAPEPIRE_OPTIONS`. With `agent=true`, the server reads the agent's socket path from `SSH_AUTH_SOCK`, the variable `ssh-agent` sets in your shell:

```env
DB2I_DRIVER=mapepire
DB2I_HOSTNAME=ibmi.example.com
DB2I_USERNAME=MCPREAD
DB2I_MAPEPIRE_OPTIONS=hostKey=SHA256:abc...xyz;agent=true
```

`DB2I_PASSWORD` can stay unset. The private key stays in the agent, with its passphrase, and the server never reads the key file. Each new SSH connection asks the agent for a signature, nothing more.

The other values:

- An absolute path, such as `agent=/run/user/1000/ssh-agent.sock`, when the server runs where `SSH_AUTH_SOCK` isn't set. A launchd job, a systemd service or a Windows service usually has no agent variables. With `agent=true` and no `SSH_AUTH_SOCK`, the server refuses to start and says so, rather than failing on the first query.
- `agent=pageant` for PuTTY's Pageant on Windows. Load the `.ppk` key into Pageant first.
- `agent=\\.\pipe\openssh-ssh-agent` for the Windows OpenSSH Authentication Agent, the `ssh-agent` service. Windows doesn't define `SSH_AUTH_SOCK`, so give the pipe name.

In a [profiles file](https://docs.db2i-mcp.com/configuration#multiple-systems), `agent` goes in each system's `mapepireOptions`, like `privateKeyFile` does.

## What the server checks

Set `agent` or `privateKeyFile`, not both. The two were competing for the same login, with one quietly winning, so the server now refuses the pair at startup. A value it doesn't recognize is refused too: `agent=yes` is not a socket path, and finding that out at startup beats finding it out from an SSH error in the first answer.

`agent=false` means what it says. The password is required again, the same as leaving the option out.

HTTP `/auth` and OAuth sign-ins are not affected. They check the caller's password by logging in over SSH with it, and they ignore both `agent` and `privateKeyFile`, so the server's own key can't stand in for anyone's password. One consequence is worth saying plainly: on an IBM i whose sshd allows public key login only, those sign-ins can't work with the Mapepire driver at all. The agent option is for the server's own connection.

The host key check from [the SSH post](/blog/mapepire-is-back-over-ssh) runs before any of this: `~/.ssh/known_hosts` or a pinned `hostKey` fingerprint, and the connection is refused on a mismatch.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

Nothing changes for a server that doesn't set `agent`. The options table in [Using the Mapepire driver](https://docs.db2i-mcp.com/configuration#using-the-mapepire-driver-ssh) has every value.
