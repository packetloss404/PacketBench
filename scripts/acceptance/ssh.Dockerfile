FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@9.15.4
WORKDIR /opt/sidecar
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY dist ./dist
COPY fixture.mjs /opt/fixture.mjs
RUN mkdir -p /run/sshd /root/.ssh /work/project /work/project/child \
    && chmod 700 /root/.ssh
# The runner supplies only its throwaway public client key. Generate a fresh
# host key per container; obtain its public half through Docker, not TOFU.
CMD ["sh", "-c", "ssh-keygen -q -t ed25519 -N '' -f /run/host_key && exec /usr/sbin/sshd -D -e -p 22 -h /run/host_key -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=prohibit-password -o AllowTcpForwarding=no -o X11Forwarding=no"]
