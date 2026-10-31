import {resolve} from 'node:path';

/** One native CPU worker, an explicit child environment, bounded calls and lifetime. */
export class PhysicsWorker {
  private process:ReturnType<typeof Bun.spawn>;
  private waiting:{resolve:(value:any)=>void;reject:(error:Error)=>void}|null=null;
  private dead=false;
  private started=Date.now();
  private checked=0;
  private lifetime:ReturnType<typeof setTimeout>;
  private root:string;
  private environment:Record<string,string>;
  constructor(root:string) {
    this.root=root;
    this.environment={HOME:resolve(root,'.cache/world/home'),TMPDIR:resolve(root,'.cache/world/tmp'),PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',
      OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',VECLIB_MAXIMUM_THREADS:'1'};
    this.checkGate();
    this.process=Bun.spawn([resolve(root,'.venv/bin/python'),'-I','-B',resolve(root,'physics/megazord.py')],{
      cwd:root,env:this.environment,stdin:'pipe',stdout:'pipe',stderr:'ignore'});
    this.lifetime=setTimeout(()=>{this.fail(new Error('Five-minute native trial limit reached'));this.process.kill();},300000);
    void this.read();
    this.process.exited.then(()=>this.fail(new Error('Native physics worker exited')));
  }
  private checkGate() {
    if(Date.now()-this.started>=300000)throw new Error('The five-minute native trial limit was reached');
    if(Date.now()-this.checked<5000)return;
    const result=Bun.spawnSync([resolve(this.root,'.venv/bin/python'),'-I','-B',resolve(this.root,'physics/run_bounded.py'),'--gate-only'],{
      cwd:this.root,env:this.environment,stdout:'pipe',stderr:'ignore',timeout:6000});
    if(result.exitCode!==0)throw new Error('Native physics host gate refused; check load and swap before restarting');
    this.checked=Date.now();
  }
  private fail(error:Error){this.dead=true;this.waiting?.reject(error);this.waiting=null;}
  private async read() {
    let pending='';const decoder=new TextDecoder();
    try {
      for await(const chunk of this.process.stdout as ReadableStream<Uint8Array>){
        pending+=decoder.decode(chunk,{stream:true});if(pending.length>250000)throw new Error('Physics response exceeded its bound');
        let newline;
        while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);
          const response=JSON.parse(line),waiting=this.waiting;this.waiting=null;
          if(!waiting)throw new Error('Unexpected physics response');
          if(!response.ok)waiting.reject(new Error('Native physics command refused'));else waiting.resolve(response.state);
        }
      }
    } catch {this.fail(new Error('Native physics response failed'));this.process.kill();}
  }
  async call(command:Record<string,unknown>) {
    if(this.dead||this.waiting)throw new Error('Physics worker is unavailable or busy');
    this.checkGate();
    const response=new Promise<any>((resolve,reject)=>this.waiting={resolve,reject});
    const timeout=setTimeout(()=>{this.fail(new Error('Native physics response timed out'));this.process.kill();},5000);
    try {
      if(typeof this.process.stdin==='number'||!this.process.stdin)throw new Error('Physics input is unavailable');
      this.process.stdin.write(JSON.stringify(command)+'\n');this.process.stdin.flush();
      return await response;
    } finally {clearTimeout(timeout);}
  }
  async stop(){clearTimeout(this.lifetime);this.fail(new Error('Physics stopped'));if(this.process.exitCode===null)this.process.kill();await this.process.exited;}
}
