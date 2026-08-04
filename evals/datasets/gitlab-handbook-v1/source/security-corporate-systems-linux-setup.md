---
slug: security-corporate-systems-linux-setup
title: "Linux Desktop OS Setup Guide"
source_url: "https://handbook.gitlab.com/handbook/security/corporate/systems/linux/setup/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: Linux Desktop OS Setup Guide
---

## Prerequisites

Before starting, ensure you have:

- A company-provided Dell laptop (Dell is the only approved Linux laptop vendor)
- Ubuntu LTS (latest version) - the only approved Linux distribution

## Setup and Deployment Steps

### 1. Install Linux (if needed)

Certain circumstances (world region and availability of hardware) might require the self-installation of Linux on a Dell that was shipped with OEM Windows. If this is the case:

1. Set up a USB drive with Ubuntu LTS
2. Perform the installation

**Optional backup:** For laptops shipped with OEM Windows, you may want to make a full drive backup (e.g., using open source utility [Clonezilla](https://clonezilla.org/)) to an external drive before installing Linux. This makes the RMA process easier if needed.

### 2. Enable Full-Disk Encryption (LUKS Required)

Full-disk encryption is mandatory. To verify encryption is enabled:

```bash
sudo dmsetup ls
```

If there is a reference to `cryptdata` or `dm_crypt-0` in the output, encryption is enabled. If not, you will need to reinstall Ubuntu and enable LUKS drive encryption during the installation process.

### 3. Enable the Firewall

Linux endpoints must have the firewall enabled. Check the status and enable if needed:

```bash
# Check firewall status
sudo ufw status

# If inactive, enable it
sudo ufw enable

# If ufw is not installed
sudo apt install ufw
```

### 4. Set Your Hostname

Before enrolling in Fleet, your hostname must follow the standardized naming convention:

```plaintext
gitlabEmail--dateOfInitialConnect-lastFiveOfSerialNumber
```

For example, if your email is `jsmith@gitlab.com`:

```plaintext
jsmith--20241202-RT7A2
```

**To rename your hostname:**

You can use `hostnamectl` to set your hostname manually:

```bash
# Get your serial number (last 5 characters)
sudo dmidecode -s system-serial-number | tail -c 6

# Set the hostname (replace with your actual values)
sudo hostnamectl set-hostname "yourusername--YYYYMMDD-SERIAL"

# Update /etc/hosts
sudo sed -i "s/127.0.1.1.*/127.0.1.1\t$(hostname)/" /etc/hosts
```

Alternatively, you can use the hostname rename script available on the internal handbook. Contact `#security_help` if you need assistance.

### 5. Install Fleet

All Linux endpoints must have Fleet installed. Fleet will also install the EDR tool (CrowdStrike or SentinelOne depending on your region).

**Download the package:**

The Fleet binary is available for DEB and RPM package managers for both x86-64 and ARM CPUs. Download the latest release from the [fleet-builds repository](https://gitlab.com/gitlab-com/gl-security/corp/engineering/fleet-builds/-/releases).

**Install the package:**

For Debian/Ubuntu (the only approved distribution):

```bash
sudo apt install ./fleet-osquery_*.deb
```

**Verify Fleet is installed:**

```bash
sudo systemctl is-enabled orbit.service
sudo systemctl is-active orbit.service
```

With supported Linux Desktop Environments (like GNOME with [the required GNOME Shell extension](https://extensions.gnome.org/extension/615/appindicator-support/)), you can see if Fleet Desktop is showing on your top bar.

For detailed Fleet enrollment instructions, see the [Fleet handbook page](https://internal.gitlab.com/handbook/security/corporate/tooling/fleet/).

### 6. Verify EDR Installation

The EDR agent should be installed automatically via Fleet. To verify:

**For SentinelOne (Netherlands, Germany, Italy, Austria):**

```bash
systemctl status sentinelone
```

Verify connectivity:

```bash
sudo sentinelctl management status
```

You should see `Connectivity: On` and a valid SentinelOne URL.

**For CrowdStrike (all other regions):**

```bash
# Check if the Falcon sensor is running
sudo systemctl status falcon-sensor

# Verify the agent ID
sudo /opt/CrowdStrike/falconctl -g --aid
```

You should see the service as active and an Agent ID (AID) value returned.

If you need assistance, reach out in `#sentinelone` or `#crowdstrike` Slack channels.

### 7. Install Standard Applications

Install the regular approved applications:

- **Google Chrome** (and sign into Okta)
- **Zoom**
- **Slack**
- Other applications for your job description (e.g., development tools)

Complete the steps in your onboarding issue and/or laptop equipment issue.

## Additional Configuration

### Automatic Updates (Recommended)

While not required, it is highly recommended that automatic updates are configured to ensure the latest security patches are available. Options include:

- **GNOME Update Manager:** Configure _Software & Updates_ for automatic updates
- **unattended-upgrades:** Install and configure the `unattended-upgrades` package

More detail is available at [Ubuntu Automatic Security Updates](https://help.ubuntu.com/community/AutomaticSecurityUpdates).

### Fingerprint Reader

If your Dell laptop has a fingerprint reader, modern Ubuntu may support it out of the box. If not, consider the following steps (results may vary):

```bash
sudo apt install libpam-fprintd
sudo systemctl status fprintd.service
sudo systemctl restart fprintd.service
```

## Troubleshooting

### SentinelOne Installation Issues

If you're using Advanced Intrusion Detection Environment (AIDE), create an exclusion for SentinelOne:

```bash
echo '!/opt/sentinelone/mount' | sudo tee -a /etc/aide.conf
```

### SentinelOne Agent Offline

The most common reason for a SentinelOne agent to appear offline is a local firewall prohibiting outbound connections to `*.sentinelone.net`. HTTPS (port 443) needs to be allowed outbound to that domain.

Check agent status:

```bash
sudo sentinelctl management status
```

Common local firewalls that may block access include pfSense and iptables.

### Fleet Package Not Available

If the appropriate Fleet package doesn't exist for your endpoint, contact `#security_help` for assistance building fleetd from source.

## Support

- **Fleet/EDR Issues:** `#security_help`
- **SentinelOne Help:** `#sentinelone`
- **CrowdStrike Help:** `#crowdstrike`
- **General Linux Tips:** `#linux`
