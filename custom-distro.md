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

### First-boot defaults — `msm89xx/base-files/etc/uci-defaults/99-vpn-tether`
Runs once on first boot and configures:
- USB gadget → **NCM**, AP fallback disabled
- WiFi **STA** skeleton (`wireless.wan_sta`) + disabled AP
- `wwan` (DHCP uplink) + `wg0` WireGuard skeleton (`auto '0'`) + empty peer
- Firewall: WAN = `wwan`+`modem`; new `vpn` zone for `wg0` (masq); **`lan → vpn` only**; removes stock `lan → wan` (kill switch)
- `dnsmasq` `filter_aaaa=1` (endpoint must resolve IPv4)
- NTP enabled; SSH (dropbear) + LuCI (uhttpd) enabled

### Clock-before-WireGuard hotplugs — `msm89xx/base-files/etc/hotplug.d/`
The dongle has **no usable RTC**, so the clock may be stale or 1970 on boot.
WireGuard's replay protection makes the server silently drop handshakes with a
stale timestamp. And once `wg0` is up its default route takes over the dongle's
own traffic (no policy routing in this kernel), so NTP could never reach the
internet to fix it.

So on **every** WiFi-uplink connect the hotplugs:
1. release `wg0`,
2. keep a direct default route via the WiFi uplink (metric 200 fallback),
3. force an NTP sync (`ntpd -q`),
4. then `ifup wg0`.

- `iface/99-vpn-after-ntp` — does the above when `wwan` comes up; tears `wg0`
  down and removes the fallback route when the uplink goes down.
- `ntp/30-vpn-start` — also starts `wg0` whenever NTP validates the clock.

### Web UI — `packages/luci-app-vpn-tether/`
A single LuCI page (`admin/services/vpn-tether`) with three inputs:

- **WiFi SSID**, **WiFi Password** → `wireless.wan_sta`
- **WireGuard config** (paste a `.conf`) → parsed to UCI:
  - `[Interface]`: `PrivateKey` → `private_key`, `Address` → `addresses`, `DNS` → dnsmasq server list
  - `[Peer]`: `PublicKey`, `PresharedKey`, `Endpoint` (host:port), `AllowedIPs`
  - sets `route_allowed_ips=1`, `persistent_keepalive=25`, `auto=0`

On Apply it commits UCI, reloads WiFi, and brings up `wg0` (which, thanks to the
hotplugs, only succeeds once the clock is valid).

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
