import { Module } from '@nestjs/common';
import { TerminalService } from './terminal.service';
import { TerminalController } from './terminal.controller';

@Module({
  providers: [TerminalService],
  controllers: [TerminalController]
})
export class TerminalModule {}
