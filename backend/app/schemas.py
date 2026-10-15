import os
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import UUID, uuid4
from pydantic import BaseModel, ConfigDict, Field, field_validator

class Severity(str, Enum):
    DEBUG = 'DEBUG'
    INFO = 'INFO'
    WARN = 'WARN'
    ERROR = 'ERROR'
    FATAL = 'FATAL'

class LogIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    event_id: UUID = Field(default_factory=uuid4)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    service: str = Field(min_length=1, max_length=100)
    host: str = Field(min_length=1, max_length=150)
    severity: Severity
    message: str = Field(min_length=1, max_length=10000)
    trace_id: str | None = Field(default=None, max_length=128)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator('timestamp')
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError('timestamp must include a timezone')
        return value

class LogEvent(LogIn):
    received_at: datetime

class GeneratorConfig(BaseModel):
    rate: int = Field(default=10, ge=1, le=min(500, max(1, int(os.getenv('MAX_GENERATION_RATE', '500')))))

class WorkerConfig(BaseModel):
    paused: bool | None = None
    delay_ms: int | None = Field(default=None, ge=0, le=5000)
