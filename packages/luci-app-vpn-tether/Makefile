include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI VPN Tether setup
LUCI_DESCRIPTION:=One-page setup (WiFi SSID, password, WireGuard config) for the msm89xx VPN tether distribution
LUCI_DEPENDS:=+wireguard-tools +kmod-wireguard +luci-proto-wireguard
LUCI_PKGARCH:=all

PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_MAINTAINER:=Miguel Fuertes <hkfuertes@gmail.com>
PKG_LICENSE:=GPL-2.0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
