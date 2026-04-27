# entities.py — backward-compatibility re-export shim.
# All model classes now live in their respective domain files.
# This file re-exports everything so existing imports continue to work.
from __future__ import annotations

from app.models.user import User, UserActionToken
from app.models.customer import Customer
from app.models.partner import Partner, TaskPartner
from app.models.project import (
    Project,
    ProjectActivity,
    ProjectClassAssignment,
    ProjectClassTemplate,
    ProjectFinance,
    ProjectMember,
    ProjectWeatherCache,
)
from app.models.task import Task, TaskAssignment
from app.models.site import Site, JobTicket
from app.models.team import EmployeeGroup, EmployeeGroupMember
from app.models.chat import (
    ChatThread,
    ChatThreadParticipantGroup,
    ChatThreadParticipantRole,
    ChatThreadParticipantUser,
    ChatThreadRead,
    Message,
    MessageReaction,
)
from app.models.report import ConstructionReport, ConstructionReportJob
from app.models.materials import MaterialCatalogItem, MaterialCatalogImportState, ProjectMaterialNeed
from app.models.notification import Notification
from app.models.werkstatt import (
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattCategory,
    WerkstattDatanormImport,
    WerkstattLocation,
    WerkstattMovement,
    WerkstattOrder,
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.models.wiki import WikiPage
from app.models.files import Attachment, ProjectFolder
from app.models.time_models import ClockEntry, BreakEntry, VacationRequest, SchoolAbsence
from app.models.settings_models import AppSetting, AuditLog

__all__ = [
    "AppSetting",
    "AuditLog",
    "Attachment",
    "BreakEntry",
    "ChatThread",
    "ChatThreadParticipantGroup",
    "ChatThreadParticipantRole",
    "ChatThreadParticipantUser",
    "ChatThreadRead",
    "ClockEntry",
    "ConstructionReport",
    "ConstructionReportJob",
    "Customer",
    "EmployeeGroup",
    "EmployeeGroupMember",
    "JobTicket",
    "MaterialCatalogImportState",
    "MaterialCatalogItem",
    "Message",
    "MessageReaction",
    "Notification",
    "Partner",
    "Project",
    "ProjectActivity",
    "ProjectClassAssignment",
    "ProjectClassTemplate",
    "ProjectFinance",
    "ProjectFolder",
    "ProjectMaterialNeed",
    "ProjectMember",
    "ProjectWeatherCache",
    "SchoolAbsence",
    "Site",
    "Task",
    "TaskAssignment",
    "TaskPartner",
    "User",
    "UserActionToken",
    "VacationRequest",
    "WerkstattArticle",
    "WerkstattArticleSupplier",
    "WerkstattCategory",
    "WerkstattDatanormImport",
    "WerkstattLocation",
    "WerkstattMovement",
    "WerkstattOrder",
    "WerkstattOrderLine",
    "WerkstattSupplier",
    "WikiPage",
]
