---
slug: security-security-operations-security-logging
title: "Security Logging"
source_url: "https://handbook.gitlab.com/handbook/security/security-operations/security-logging/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: "Security Logging"
description: "Security Logging supports and develops GitLab's security log ingestion platform."
---

This page establishes the [Security Logging team's](/handbook/security/security-operations/security-logging/) mission, responsibilities, and operational framework within GitLab's [Security Operations](/handbook/security/security-operations/) organization. The team serves as the cornerstone of GitLab's security observability, ensuring comprehensive logging coverage to protect the company and its customers while maintaining compliance with regulatory requirements. Our work directly supports operational security excellence through reliable, scalable, and accessible security logging infrastructure.

## <i class="fas fa-rocket" id="biz-tech-icons"></i> Our Vision

Guarantee that GitLab has the logging data coverage required to:

- Perform the threat analysis, alerting and threat detections necessary to protect the company and its customers
- Ensure compliance with internal policies, standards, internal and external audits, and regulatory requirements
- Enable proactive security operations through comprehensive monitoring and rapid threat detection
- Support security teams with reliable, accessible, and actionable logging data

### Our Mission Statement

The [Security Logging team](/handbook/security/security-operations/security-logging/) achieves its vision by planning, executing, and supporting initiatives that improve the coverage and usability of security logging data at GitLab. We manage, maintain, design, configure, and document the necessary tools, systems, and processes to enable comprehensive security observability while continuously evolving our capabilities to serve all security operations teams effectively.

Further details can be found in the [job family description](/job-description-library/security/security-logging/).

## <i class="fas fa-users" id="biz-tech-icons"></i> The Team

### Team Members

| | |
|---|---|
|Daryn Wilkinson|[Manager, Security Engineering](/job-description-library/security/security-logging/)|
|Hiroki Suezawa|[Staff Security Engineer](/job-description-library/security/security-logging/)|
|Senior Engineer 1 (redacted for privacy)|[Senior Security Engineer](/job-description-library/security/security-logging/)|
|Senior Engineer 2 (redacted for privacy)|[Senior Security Engineer](/job-description-library/security/security-logging/)|

## Core Responsibilities

### Primary Ownership Areas

**SIEM Platform Management**

- Ownership, management, and maintenance of GitLab's SIEM platforms and security logging infrastructure
- Subject matter expertise regarding SIEM operation and management in support of security operations workflows
- Capacity planning and forecasting of licensing and infrastructure costs

**Log Source Integration and Management**

- Coordinating and executing log source ingestion across GitLab's infrastructure
- Building and maintaining a library of logging profiles for various technologies that support security operations needs
- Ensuring reliability and availability of log data for security operations purposes
- Managing the integration of diverse log sources into searchable, actionable datasets

**Standards and Documentation**

- Ownership of the Security Logging Standard that defines requirements for security logging, monitoring, and alerting at GitLab
- Designing, managing, and maintaining security logging and monitoring infrastructure that supports security operations excellence
- Documenting tools, systems, and processes to support effective security operations

**Compliance and Audit Support**

- Supporting internal and external audit processes through data extraction, analysis, and reporting from SIEM platforms
- Collaborating with GRC teams to ensure logging infrastructure meets regulatory and compliance requirements
- Maintaining data retention policies that support compliance obligations

**Internal Customer Support**

- Working with internal GitLab security operations teams to ensure reliable access to logging data
- Supporting security operations teams during platform transitions and capability improvements
- Managing data migration and ensuring continuity with minimal impact on security operations

## Collaborative Responsibilities

**Cross-Team Coordination Within Security Operations**

- Working closely with SIRT to ensure log aggregation infrastructure supports incident response workflows
- Collaborating with Security teams to identify and address logging gaps
- Supporting continuous security monitoring and threat hunting through comprehensive log availability

**Compliance and Governance Coordination**

- Partnering with GRC team to fulfill audit data requests and compliance reporting requirements
- Working with Legal team to ensure logging practices align with data protection regulations

**Strategic Planning and Optimization**

- Overall management and coordination of the security logging program in alignment with security operations objectives
- Regular assessment of logging sources for volume optimization and cost efficiency
- Implementation of monitoring frameworks for system health and performance that support security operations SLAs

## Operational Framework

### Working Methodology

We operate as an internal customer-focused and customer-driven team within security operations, balancing stakeholder needs with risk-based approaches to minimize security risk at GitLab. Our methodology embraces:

- DevOps model implementation aligned with security operations practices
- Software-defined infrastructures
- Cloud-first approach supporting security operations workflows
- Modular, decoupled architectures that support scalability and flexibility
- Self-serviceability principles for security operations teams
- Automation-first mindset for efficient security operations

### Communication Channels

**Primary Contact Methods:**

- Slack: `#security_help` and tag `@security-logging-team`
- GitLab issues: [Security Logging issue tracker](https://gitlab.com/gitlab-com/gl-security/engineering-and-research/security-logging/security-logging/-/issues)

**Project Coordination:**

- Team repo: [Security Logging GitLab Sub-Group](https://gitlab.com/gitlab-com/gl-security/engineering-and-research/security-logging/security-logging)
- All epics managed at sub-group level for clear prioritization within security operations

### Meeting Structure

**Regular Synchronous Activities:**

- Regular team sync: Progress discussion, blocker resolution, security operations coordination
- Bi-annual retrospectives: Team check-in and improvement planning with security operations alignment
- Individual contributor 1-1s with Engineering Manager
- Regular coordination with Security Operations leadership on strategic initiatives

**Asynchronous Preference:** Primary work conducted through project issue tracker with public documentation accessible to security operations teams

## Cross-Team Integration Framework

### Security Incident Response Team (SIRT) Partnership

- **SIRT Responsibilities:**
  - Adapt incident response workflows to leverage current SIEM capabilities
  - Document logging gaps using established prioritization procedures
  - Configure incident response-specific automation and monitoring
  - Guide Security Logging Standard development through collaboration on requirements that support incident response operations

### Infrastructure Security (InfraSec) Partnership

- **InfraSec Responsibilities:**
  - Ensure Security Logging Standard adoption in infrastructure
  - Provide advance notice of infrastructure log format changes
  - Bridge security logging and infrastructure teams during platform improvements
  - Shared capacity planning and cost forecasting for security logging platforms

### Governance, Risk, and Compliance (GRC) Partnership

- **GRC Responsibilities:**
  - Define compliance logging requirements based on regulatory frameworks and internal policies
  - Coordinate audit planning and timeline communication with Security Logging team

### Broader Security Operations Integration

- **Security Operations Teams Responsibilities:**
  - Submit logging requests through documented processes that consider current platform capabilities
  - Provide detection suggestions with high ROI potential that enhance security operations effectiveness
  - Collaborate on security logging standard implementation that supports security operations workflows
  - Participate in platform training and adoption initiatives

## Project Management and Governance

### Project Lifecycle Management

- **Strategic Planning:** Long-term roadmap alignment with security operations requirements and future consolidation objectives
- **Tactical Execution:** Quarterly milestones focused on platform improvement and epic management aligned with security operations priorities
- **Operational Delivery:** Issue board-based work tracking with regular backlog grooming prioritizing security operations needs

### Project Ownership Framework

Each project requires a DRI responsible for:

- Regular status updates in epic descriptions and milestones
- Cross-functional collaboration for issue resolution with security operations teams
- Stakeholder communication and delivery coordination aligned with security operations needs

## Success Metrics and KPIs

### Platform Performance Metrics

- **System Reliability:** Uptime metrics for log ingestion pipeline supporting security operations SLAs
- **Logging Pipeline Efficiency:** MTTS (mean time to SIEM) trending with security operations benchmarks
- **Data Quality:** Log completeness, accuracy, and timeliness metrics
- **Security Operations Support:** Response time to security team requests and issue resolution

### Compliance and Audit Metrics

- **Data Retention Compliance:** Adherence to regulatory data retention requirements across log sources
- **Regulatory Coverage:** Percentage of compliance requirements supported by logging infrastructure

### Operational Excellence Indicators

- **Cost Optimization:** Efficient resource utilization and cost management
- **Performance Improvements:** Query response times, system throughput, and processing efficiency
- **Stakeholder Satisfaction:** Security operations team feedback on platform experience and capabilities

### Strategic Alignment Metrics

- **Security Coverage:** Percentage of critical assets with appropriate logging supporting security operations monitoring
- **Cost-Effective Coverage:** Balance of security value (detections, investigations, compliance) to logging costs, ensuring efficient resource allocation
- **Innovation Impact:** New detection capabilities enabled through logging infrastructure improvements

## Risk Management and Mitigation

### Identified Risk Areas

- **Platform Migration Complexity:** Managing technical challenges during Elastic migration while maintaining operational continuity
- **Data Loss Prevention:** Ensuring continuity during platform improvements without impacting security operations capabilities
- **Security Operations Adaptation:** Managing security operations team transitions during platform enhancements
- **Resource Optimization:** Balancing comprehensive coverage with cost efficiency while meeting security operations requirements
- **Compliance Data Availability:** Risk of audit findings due to insufficient logging coverage or data retention gaps

### Mitigation Strategies

- **Comprehensive Planning:** Detailed migration and improvement roadmaps with rollback procedures and security operations continuity planning
- **Stakeholder Communication:** Regular updates through established DCI framework with security operations leadership involvement
- **Continuous Monitoring:** Proactive identification of system degradation in order to minimize impact on security operations
- **Cross-Team Collaboration:** Shared responsibility model for critical functions within security operations
- **Compliance Preparedness:** Proactive audit readiness through regular compliance data validation and retention policy enforcement
