import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

export const omniBindingConfigWakeupId = (eventId: string): string =>
  uuidV5(
    'omni:binding.config-wakeup:v1',
    z.uuid().parse(eventId).toLowerCase(),
  );
