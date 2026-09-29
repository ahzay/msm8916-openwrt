# VPN Tether Distribution (custom build)

A pre-configured, bulletproof OpenWrt distribution for the UF02 dongle. Plug it
into any PC (USB), and it becomes a VPN gateway:

- joins a configured WiFi uplink,
- routes **all traffic from the USB-connected PC** through WireGuard,
- serves the PC via USB (NCM) with DHCP,
- is always reachable at `http://192.168.1.1` (LuCI) and over SSH to change settings.

The only thing the user does is open the web UI and fill **three fields**:
**WiFi SSID**, **WiFi password**, and **paste a WireGuard client config**.

## Components

The VPN tether functionality is a **self-contained `luci-app-vpn-tether` package**
(`packages/luci-app-vpn-tether/`) — UI + hotplugs + generic first-boot defaults —
so it can be dropped onto any OpenWrt with WiFi + WireGuard. Only the
device-specific USB gadget setup stays in the image.

### Web UI — `packages/luci-app-vpn-tether/htdocs/..`
A single LuCI page (`admin/services/vpn-tether`) with three inputs:

- **WiFi SSID**, **WiFi Password** → `wireless.wan_sta`
- **WireGuard config** (paste a `.conf`) → parsed to UCI:
  - `[Interface]`: `PrivateKey` → `private_key`, `Address` → `addresses`, `DNS` → dnsmasq server list
  - `[Peer]`: `PublicKey`, `PresharedKey`, `Endpoint` (host:port), `AllowedIPs`
  - sets `route_allowed_ips=1`, `persistent_keepalive=25`, `auto=0`

All fields are pre-filled from the current config (nothing masked) so they can be
edited. On Apply it commits UCI, reloads WiFi, and brings up `wg0`.

### First-boot defaults — `packages/luci-app-vpn-tether/root/etc/uci-defaults/99-luci-app-vpn-tether`
Runs once after install. Generic: creates the `wwan`/`wg0`/peer/`wan_sta` UCI
skeleton, the firewall `vpn` zone + `lan → vpn` (removing `lan → wan`),
`dnsmasq filter_aaaa`, and enables NTP. It finds the WAN zone by name (no index
assumptions) and does not touch the modem.

### Clock-before-WireGuard hotplugs — `packages/luci-app-vpn-tether/root/etc/hotplug.d/`
The router may have no usable RTC, so the clock can be stale on boot. WG's
replay protection silently drops handshakes with a stale timestamp, and once
`wg0` is up its default route takes over the router's own traffic (no policy
routing), so NTP could never sync.

So on **every** WiFi-uplink connect the hotplugs:
1. release `wg0`,
2. keep a direct default route via the WiFi uplink (metric 200 fallback; netdev
   derived from `ubus network.interface.wwan status`),
3. force an NTP sync (`ntpd -q`),
4. then `ifup wg0`.

- `iface/99-vpn-after-ntp` — does the above when `wwan` comes up; tears `wg0`
  down and removes the fallback route when the uplink goes down.
- `ntp/30-vpn-start` — also starts `wg0` whenever NTP validates the clock.

### Device-specific (image only) — `msm89xx/base-files/`
- `99-usb-gadget-ncm` — present the dongle as a USB ethernet gadget (NCM).
- (plus the pre-existing modem/`qcom-soc` defaults)

## Build

Requires Docker. No compose plugin needed.

```sh
# 1. Build the builder image (clones OpenWrt v25.12.5 + feeds)
docker build -f devenv/Dockerfile -t openwrt-builder \
    --build-arg OPENWRT_VERSION=v25.12.5 .

# 2. Build the firmware (mounts packages/ and msm89xx/ into the tree)
docker run --rm \
  -v $PWD:/repo \
  -v $PWD/packages:/home/builder/openwrt/package/msm8916 \
  -v $PWD/msm89xx:/home/builder/openwrt/target/linux/msm89xx \
  -v $PWD/bin:/home/builder/openwrt/bin \
  -v /tmp/omwrt-dl:/home/builder/openwrt/dl \
  openwrt-builder:latest bash -c \
  "cd /home/builder/openwrt && cp /repo/diffconfig_uf02 .config && make defconfig && make -j\$(nproc)"
```

Artifacts land in `bin/targets/msm89xx/msm8916/`:
`...-squashfs-gpt_both0.bin`, `...-squashfs-boot.img`, `...-squashfs-system.img`,
`...-flash.sh`, `...-firmware.zip`, `...-sysupgrade.bin`.

Copied `diffconfig` additions:
```
CONFIG_PACKAGE_luci-app-vpn-tether=y
```

## Flash

From the build output directory (device in EDL — see `vpn-tether.md` §7):

```
./openwrt-msm89xx-msm8916-generic-uf02-flash.sh
```

## First-run

1. Plug the dongle into a PC (USB). It enumerates as a USB ethernet (NCM) and the PC gets a DHCP lease.
2. Open `http://192.168.1.1` → **Services → VPN Tether**.
3. Fill SSID + password, paste the WireGuard config, **Apply**.
4. The dongle reconnects to the WiFi, waits for NTP, starts WireGuard, and the PC's traffic flows through the tunnel.

## Verify (SSH)

```
date -u                       # correct year (NTP synced)
iw dev phy0-sta0 link         # connected to the uplink
wg show                       # latest handshake + transfer
ip route show default         # default dev wg0
```

## Behavior

- **Kill switch:** if WireGuard never comes up, the PC has no internet (only `lan → vpn` is forwarded).
- The dongle's own traffic shares the `wg0` default once up (this kernel has no policy routing).
- Recovery: see `vpn-tether.md` §7 (short USB D+ to GND during power-up to enter EDL).
