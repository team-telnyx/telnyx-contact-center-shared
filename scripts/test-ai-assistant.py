#!/usr/bin/env python3
"""
Healthcare Intake AI Assistant - Automated Text Testing Script

Tests the Telnyx AI Assistant by simulating customer conversations
through the Chat API. Validates workflow progression and slot collection.

Usage:
    python test-ai-assistant.py [--assistant-id ID] [--verbose]
    
Environment:
    TELNYX_API_KEY - Required for API access
"""

import os
import sys
import json
import time
import argparse
import requests
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any

# Configuration
DEFAULT_ASSISTANT_ID = "assistant-06fd0ed6-69fd-4235-986b-72e5ae1af71c"
API_BASE = "https://api.telnyx.com/v2"

# Test scenarios
TEST_SCENARIOS = {
    "full_workflow": {
        "name": "Complete Healthcare Intake Workflow",
        "description": "Tests all 6 stages with valid data",
        "messages": [
            ("Hello, I need to arrange a medical transport", "greeting"),
            ("My name is John Smith", "caller_name"),
            ("I'm calling from Memorial Hospital", "caller_facility"),
            ("You can reach me at 555-123-4567", "callback_number"),
            ("Yes that's correct", "confirm_callback"),
            ("I need a new transport", "intent"),
            ("Yes, that's correct", "confirm_intent"),
            ("The patient is Maria Garcia", "patient_name"),
            ("Date of birth is March 15, 1965", "patient_dob"),
            ("She weighs about 140 pounds", "patient_weight"),
            ("Female", "patient_gender"),
            ("Pickup from Memorial Hospital", "pickup_facility"),
            ("Room 302 in the ICU", "pickup_location"),
            ("Cardiac surgery", "transport_reason"),
            ("2 IV drips", "iv_count"),
            ("Oxygen support only", "special_equipment"),
            ("Yes, her husband will accompany", "accompanying"),
            ("No isolation precautions needed", "isolation"),
            ("Yes, all information is correct", "confirm_all"),
            ("No, that's all. Thank you!", "close"),
        ],
        "expected_slots": [
            "caller_name", "caller_facility", "callback_number", "intent",
            "patient_name", "patient_dob", "patient_weight", "patient_gender",
            "pickup_facility", "pickup_location", "transport_reason",
            "iv_count", "special_equipment", "accompanying", "isolation"
        ]
    },
    
    "transfer_early": {
        "name": "Early Transfer to Human Agent",
        "description": "Customer requests human agent after providing partial info",
        "messages": [
            ("Hello", "greeting"),
            ("My name is Jane Doe from City Hospital", "caller_info"),
            ("I need to speak to a human agent please", "transfer_request"),
        ],
        "expected_behavior": "transfer_initiated"
    },
    
    "transfer_mid_workflow": {
        "name": "Mid-Workflow Transfer",
        "description": "Customer requests transfer after patient info collected",
        "messages": [
            ("Hello, I need a new transport", "greeting"),
            ("I'm Sarah Johnson from General Hospital", "caller_info"),
            ("Callback is 555-987-6543", "callback"),
            ("Yes correct, new transport", "confirm"),
            ("Patient is Robert Brown, DOB January 5, 1970", "patient_basic"),
            ("Male, 180 pounds", "patient_details"),
            ("Actually, can I speak with a real person?", "transfer_request"),
        ],
        "expected_behavior": "transfer_with_summary"
    },
    
    "out_of_order_info": {
        "name": "Out of Order Information",
        "description": "Customer provides information in non-standard order",
        "messages": [
            ("Hi, I need transport for patient Maria Lopez from St. Mary's Hospital", "combined_info"),
            ("My name is Dr. Chen, callback 555-111-2222", "caller_info"),
            ("She's 65 years old, female, 130 lbs, needs ventilator", "patient_details"),
            ("Yes new transport, picking up from ICU room 405", "transport_info"),
            ("Heart failure, 3 IVs, her daughter will accompany", "more_details"),
            ("No isolation needed", "safety"),
            ("Yes that's all correct", "confirm"),
            ("Thank you", "close"),
        ],
        "expected_behavior": "handles_gracefully"
    },
    
    "status_check": {
        "name": "Status Check Intent",
        "description": "Customer wants to check status instead of new transport",
        "messages": [
            ("Hello", "greeting"),
            ("I'm calling to check on a transport status", "intent_status"),
        ],
        "expected_behavior": "handles_non_transport"
    },
    
    "frustrated_customer": {
        "name": "Frustrated Customer",
        "description": "Customer expresses frustration",
        "messages": [
            ("Hello", "greeting"),
            ("My name is Tom Wilson", "name"),
            ("This is taking too long, I need to speak to someone now!", "frustrated"),
        ],
        "expected_behavior": "offers_transfer"
    }
}


@dataclass
class TestResult:
    scenario_name: str
    passed: bool
    messages_exchanged: int
    duration_seconds: float
    conversation_id: str
    errors: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    transcript: List[Dict[str, str]] = field(default_factory=list)


class AIAssistantTester:
    def __init__(self, api_key: str, assistant_id: str, verbose: bool = False):
        self.api_key = api_key
        self.assistant_id = assistant_id
        self.verbose = verbose
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
    
    def log(self, message: str, level: str = "INFO"):
        if self.verbose or level in ["ERROR", "WARN"]:
            timestamp = datetime.now().strftime("%H:%M:%S")
            print(f"[{timestamp}] [{level}] {message}")
    
    def create_conversation(self, name: str) -> Optional[str]:
        """Create a new conversation for testing."""
        url = f"{API_BASE}/ai/conversations"
        payload = {
            "name": name,
            "metadata": {
                "assistant_id": self.assistant_id,
                "telnyx_conversation_channel": "sms_chat",
                "test_run": True,
                "timestamp": datetime.now().isoformat()
            }
        }
        
        try:
            response = requests.post(url, headers=self.headers, json=payload)
            response.raise_for_status()
            data = response.json()
            conv_id = data.get("data", {}).get("id")
            self.log(f"Created conversation: {conv_id}")
            return conv_id
        except Exception as e:
            self.log(f"Failed to create conversation: {e}", "ERROR")
            return None
    
    def send_message(self, conversation_id: str, content: str) -> Optional[str]:
        """Send a message and get AI response."""
        url = f"{API_BASE}/ai/assistants/{self.assistant_id}/chat"
        payload = {
            "content": content,
            "conversation_id": conversation_id
        }
        
        try:
            response = requests.post(url, headers=self.headers, json=payload)
            response.raise_for_status()
            data = response.json()
            return data.get("content", "")
        except Exception as e:
            self.log(f"Failed to send message: {e}", "ERROR")
            return None
    
    def run_scenario(self, scenario_key: str) -> TestResult:
        """Run a single test scenario."""
        scenario = TEST_SCENARIOS[scenario_key]
        self.log(f"\n{'='*60}")
        self.log(f"Running: {scenario['name']}")
        self.log(f"Description: {scenario['description']}")
        self.log(f"{'='*60}")
        
        start_time = time.time()
        result = TestResult(
            scenario_name=scenario["name"],
            passed=True,
            messages_exchanged=0,
            duration_seconds=0,
            conversation_id=""
        )
        
        # Create conversation
        conv_id = self.create_conversation(f"Test: {scenario['name']}")
        if not conv_id:
            result.passed = False
            result.errors.append("Failed to create conversation")
            return result
        
        result.conversation_id = conv_id
        
        # Run through messages
        for user_message, step_name in scenario["messages"]:
            self.log(f"\n[USER] {user_message}")
            
            ai_response = self.send_message(conv_id, user_message)
            if ai_response is None:
                result.passed = False
                result.errors.append(f"No response at step: {step_name}")
                break
            
            self.log(f"[AI] {ai_response}")
            
            result.transcript.append({
                "step": step_name,
                "user": user_message,
                "ai": ai_response
            })
            result.messages_exchanged += 1
            
            # Check for expected behaviors
            if "transfer" in step_name.lower():
                if "transfer" in ai_response.lower() or "team member" in ai_response.lower():
                    result.notes.append(f"✓ Transfer detected at {step_name}")
                else:
                    result.notes.append(f"⚠ Expected transfer at {step_name}")
            
            # Small delay to avoid rate limiting
            time.sleep(0.3)
        
        result.duration_seconds = time.time() - start_time
        
        # Validate expected slots for full workflow
        if scenario_key == "full_workflow":
            # Check if confirmation/readback was done
            full_transcript = " ".join([t["ai"] for t in result.transcript])
            
            checks = [
                ("caller" in full_transcript.lower() and "john" in full_transcript.lower(), "Caller name in readback"),
                ("memorial" in full_transcript.lower(), "Facility in readback"),
                ("maria" in full_transcript.lower(), "Patient name in readback"),
                ("reference" in full_transcript.lower() or "confirmation" in full_transcript.lower(), "Reference number provided"),
            ]
            
            for check, desc in checks:
                if check:
                    result.notes.append(f"✓ {desc}")
                else:
                    result.notes.append(f"⚠ Missing: {desc}")
        
        return result
    
    def run_all_scenarios(self) -> List[TestResult]:
        """Run all test scenarios."""
        results = []
        for scenario_key in TEST_SCENARIOS:
            result = self.run_scenario(scenario_key)
            results.append(result)
            time.sleep(1)  # Pause between scenarios
        return results
    
    def print_summary(self, results: List[TestResult]):
        """Print test summary."""
        print("\n" + "="*70)
        print("TEST SUMMARY")
        print("="*70)
        
        passed = sum(1 for r in results if r.passed)
        failed = len(results) - passed
        
        for result in results:
            status = "✅ PASS" if result.passed else "❌ FAIL"
            print(f"\n{status} | {result.scenario_name}")
            print(f"       Messages: {result.messages_exchanged} | Duration: {result.duration_seconds:.1f}s")
            print(f"       Conversation: {result.conversation_id}")
            
            for note in result.notes:
                print(f"       {note}")
            
            for error in result.errors:
                print(f"       ❌ Error: {error}")
        
        print("\n" + "="*70)
        print(f"TOTAL: {passed}/{len(results)} passed ({passed/len(results)*100:.0f}%)")
        print("="*70)
        
        return failed == 0
    
    def export_results(self, results: List[TestResult], filepath: str):
        """Export results to JSON file."""
        export_data = {
            "test_run": datetime.now().isoformat(),
            "assistant_id": self.assistant_id,
            "results": [
                {
                    "scenario": r.scenario_name,
                    "passed": r.passed,
                    "messages": r.messages_exchanged,
                    "duration": r.duration_seconds,
                    "conversation_id": r.conversation_id,
                    "errors": r.errors,
                    "notes": r.notes,
                    "transcript": r.transcript
                }
                for r in results
            ]
        }
        
        with open(filepath, 'w') as f:
            json.dump(export_data, f, indent=2)
        
        print(f"\nResults exported to: {filepath}")


def main():
    parser = argparse.ArgumentParser(description="Test AI Assistant via Chat API")
    parser.add_argument("--assistant-id", default=DEFAULT_ASSISTANT_ID, 
                        help="Telnyx AI Assistant ID")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show detailed output")
    parser.add_argument("--scenario", "-s", choices=list(TEST_SCENARIOS.keys()),
                        help="Run specific scenario only")
    parser.add_argument("--export", "-e", type=str,
                        help="Export results to JSON file")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List available scenarios")
    
    args = parser.parse_args()
    
    if args.list:
        print("\nAvailable test scenarios:")
        for key, scenario in TEST_SCENARIOS.items():
            print(f"  {key}")
            print(f"    {scenario['name']}")
            print(f"    {scenario['description']}\n")
        return 0
    
    # Get API key
    api_key = os.environ.get("TELNYX_API_KEY")
    if not api_key:
        # Try to load from .env
        env_file = os.path.join(os.path.dirname(__file__), "..", ".env")
        if os.path.exists(env_file):
            with open(env_file) as f:
                for line in f:
                    if line.startswith("TELNYX_API_KEY="):
                        api_key = line.split("=", 1)[1].strip()
                        break
    
    if not api_key:
        print("Error: TELNYX_API_KEY not found")
        print("Set it as environment variable or in .env file")
        return 1
    
    # Run tests
    tester = AIAssistantTester(api_key, args.assistant_id, args.verbose)
    
    print(f"\n🤖 Testing AI Assistant: {args.assistant_id}")
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    
    if args.scenario:
        results = [tester.run_scenario(args.scenario)]
    else:
        results = tester.run_all_scenarios()
    
    success = tester.print_summary(results)
    
    if args.export:
        tester.export_results(results, args.export)
    
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
